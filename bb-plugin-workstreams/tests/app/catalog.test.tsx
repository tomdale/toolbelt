// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { Catalog } from "../../src/app/page/Catalog.tsx";
import type { TopicState, Topic } from "../../src/domain/topics.ts";

beforeEach(() => {
  installTestPluginRuntime();
});

afterEach(cleanup);

const entries: Topic[] = [
  {
    id: "p",
    name: "Lantern",
    description: "Product",
    parentId: null,
    aliases: [],
  },
  {
    id: "f",
    name: "Shelves",
    description: "Share collections",
    parentId: "p",
    aliases: ["Storage"],
  },
  {
    id: "retained",
    name: "Quiet Feature",
    description: "Archive tooling",
    parentId: null,
    aliases: ["ArchiveTool"],
  },
];

const catalogState: TopicState = {
  entities: entries,
  groups: { sec_1: "p" },
  assignments: {
    "t-root": {
      threadId: "t-root",
      entityId: "f",
      status: "assigned",
      provenance: "manual",
      label: "Lantern: Shelves",
      ancestorIds: ["f", "p"],
      evidence: null,
      inheritedFrom: null,
    },
    "t-child": {
      threadId: "t-child",
      entityId: "f",
      status: "assigned",
      provenance: "full",
      label: "Lantern: Shelves",
      ancestorIds: ["f", "p"],
      evidence: "recap",
      inheritedFrom: "t-root",
    },
  },
  revision: 3,
};

describe("Catalog UI & Maintenance", () => {
  it("shows every topic with its path and aliases, and searches them", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "catalog") return catalogState;
      return {};
    });

    render(<Catalog rpc={{ call } as never} />);

    expect(await screen.findByText("Shelves")).toBeTruthy();
    expect(screen.getByText("Quiet Feature")).toBeTruthy();
    expect(screen.getByText("Lantern › Shelves")).toBeTruthy();

    // Filter by alias "Storage"
    fireEvent.change(screen.getByLabelText("Search topics"), {
      target: { value: "Storage" },
    });
    expect(screen.getByText("Shelves").getAttribute("title")).toBe(
      "Lantern › Shelves",
    );
    expect(screen.getByText("Lantern", { selector: "h3" })).toBeTruthy();
    expect(screen.queryByText("Quiet Feature")).toBeNull();

    // Filter by alias "ArchiveTool"
    fireEvent.change(screen.getByLabelText("Search topics"), {
      target: { value: "ArchiveTool" },
    });
    expect(screen.getByText("Quiet Feature")).toBeTruthy();
    expect(screen.queryByText("Shelves")).toBeNull();

    // Search unmatched
    fireEvent.change(screen.getByLabelText("Search topics"), {
      target: { value: "nonexistent" },
    });
    expect(screen.getByText("No matching topics")).toBeTruthy();
  });

  it("shows no thread or workstream state", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "catalog") return catalogState;
      return {};
    });

    const { container } = render(<Catalog rpc={{ call } as never} />);
    await screen.findByText("Shelves");

    const text = container.textContent ?? "";
    for (const leak of [
      "Tasks",
      "root",
      "child",
      "Home:",
      "derived",
      "Retained",
      "workstream",
      "rev ",
      "related",
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it("creates a new topic with parent and aliases", async () => {
    const call = vi.fn(async (method: string, args: unknown) => {
      if (method === "catalog") return catalogState;
      if (method === "catalogCreate") {
        return {
          entity: {
            id: "new_1",
            name: "Settings",
            description: "User settings",
            parentId: "p",
            aliases: ["Preferences"],
          },
        };
      }
      return {};
    });

    render(<Catalog rpc={{ call } as never} />);
    expect(await screen.findByText("Lantern")).toBeTruthy();

    // Click "New product or feature"
    fireEvent.click(screen.getByRole("button", { name: /New topic/i }));

    expect(screen.getByRole("heading", { name: "New topic" })).toBeTruthy();
    fireEvent.change(
      screen.getByPlaceholderText("e.g. Workstreams, Sidebar, Billing"),
      {
        target: { value: "Settings" },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText("What work belongs in this topic?"),
      {
        target: { value: "User settings" },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText("Alternative names, separated by commas"),
      {
        target: { value: "Preferences, Config" },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith("catalogCreate", {
        name: "Settings",
        description: "User settings",
        parentId: null,
        aliases: ["Preferences", "Config"],
      });
    });
  });

  it("handles create conflict errors cleanly in the UI", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "catalog") return catalogState;
      if (method === "catalogCreate") {
        throw new Error(
          "Corpus entity name conflicts with an existing identity in this parent scope",
        );
      }
      return {};
    });

    render(<Catalog rpc={{ call } as never} />);
    await screen.findByText("Lantern");

    fireEvent.click(screen.getByRole("button", { name: /New topic/i }));
    fireEvent.change(
      screen.getByPlaceholderText("e.g. Workstreams, Sidebar, Billing"),
      {
        target: { value: "Lantern" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText(
        "Corpus entity name conflicts with an existing identity in this parent scope",
      ),
    ).toBeTruthy();
  });

  it("renames a topic", async () => {
    const call = vi.fn(async (method: string, args: unknown) => {
      if (method === "catalog") return catalogState;
      if (method === "catalogRename") {
        return { entity: { ...entries[1], name: "Storage Shelves" } };
      }
      return {};
    });

    render(<Catalog rpc={{ call } as never} />);
    await screen.findByText("Shelves");

    fireEvent.click(screen.getByRole("button", { name: "Rename Shelves" }));
    expect(screen.getByText("Rename topic")).toBeTruthy();

    const input = screen.getByRole("textbox", { name: "Name *" });
    fireEvent.change(input, { target: { value: "Storage Shelves" } });

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith("catalogRename", {
        entityId: "f",
        name: "Storage Shelves",
      });
    });
  });

  it("moves a topic under another parent and handles cycle errors", async () => {
    const call = vi.fn(async (method: string, args: unknown) => {
      if (method === "catalog") return catalogState;
      if (method === "catalogReparent") {
        const { parentId } = args as { parentId: string };
        if (parentId === "f")
          throw new Error("Cannot reparent: cycle detected");
        return { entity: { ...entries[0], parentId } };
      }
      return {};
    });

    render(<Catalog rpc={{ call } as never} />);
    await screen.findByText("Lantern");

    fireEvent.click(screen.getByRole("button", { name: "Move Lantern" }));
    expect(screen.getByText("Move topic")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith("catalogReparent", {
        entityId: "p",
        parentId: null,
      });
    });
  });

  it("merges a topic and preserves references", async () => {
    const call = vi.fn(async (method: string, args: unknown) => {
      if (method === "catalog") return catalogState;
      if (method === "catalogMerge") {
        return {
          target: { ...entries[0] },
          affectedThreads: 1,
          reparentedChildren: 1,
        };
      }
      return {};
    });

    render(<Catalog rpc={{ call } as never} />);
    await screen.findByText("Shelves");

    fireEvent.click(
      screen.getByRole("button", { name: "Merge Shelves into another topic" }),
    );
    expect(screen.getByText("Merge topic")).toBeTruthy();

    // Select target entity
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "retained" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith("catalogMerge", {
        sourceEntityId: "f",
        targetEntityId: "retained",
      });
    });
  });

  it("edits a topic's description and aliases", async () => {
    const call = vi.fn(async (method: string, args: unknown) => {
      if (method === "catalog") return catalogState;
      if (method === "catalogUpdateMetadata") {
        return { entity: { ...entries[1] } };
      }
      return {};
    });

    render(<Catalog rpc={{ call } as never} />);
    await screen.findByText("Shelves");

    fireEvent.click(
      screen.getByRole("button", { name: "Edit details for Shelves" }),
    );
    expect(screen.getByText("Edit Details: Shelves")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Updated description" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Alternative names, separated by commas"),
      {
        target: { value: "StorageBox, Locker" },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith("catalogUpdateMetadata", {
        entityId: "f",
        description: "Updated description",
        aliases: ["StorageBox", "Locker"],
      });
    });
  });

  it("reports a load failure and allows retry", async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue({
        entities: [],
        groups: {},
        assignments: {},
        revision: 1,
      });

    render(<Catalog rpc={{ call } as never} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Offline");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No topics yet")).toBeTruthy();
  });
});
