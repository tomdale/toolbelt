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
import type { CatalogState, CorpusEntity } from "../../src/domain/corpus.ts";

beforeEach(() => {
  installTestPluginRuntime();
});

afterEach(cleanup);

const entries: CorpusEntity[] = [
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
    description: "Retained without current workstream",
    parentId: null,
    aliases: ["ArchiveTool"],
  },
];

const catalogState: CatalogState = {
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
      provenance: "automatic",
      label: "Lantern: Shelves",
      ancestorIds: ["f", "p"],
      evidence: "recap",
      inheritedFrom: "t-root",
    },
  },
  revision: 3,
};

describe("Catalog UI & Maintenance", () => {
  it("shows all known entries, full paths, aliases, and searches inactive features", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "catalog") return catalogState;
      return {};
    });

    render(
      <Catalog
        rpc={{ call } as never}
        sections={[
          {
            id: "sec_1",
            name: "Lantern Alpha",
            createdAt: 1,
            updatedAt: 1,
          } as never,
        ]}
      />,
    );

    expect(await screen.findByText("Shelves")).toBeTruthy();
    expect(screen.getByText("Quiet Feature")).toBeTruthy();
    expect(
      screen.getAllByText("Retained (no active workstream)").length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Workstream: Lantern Alpha")).toBeTruthy();

    // Filter by alias "Storage"
    fireEvent.change(screen.getByLabelText("Search products and features"), {
      target: { value: "Storage" },
    });
    expect(screen.getByText("Shelves").getAttribute("title")).toBe(
      "Lantern: Shelves",
    );
    expect(screen.getByText("Lantern", { selector: "h3" })).toBeTruthy();
    expect(screen.queryByText("Quiet Feature")).toBeNull();

    // Filter by alias "ArchiveTool"
    fireEvent.change(screen.getByLabelText("Search products and features"), {
      target: { value: "ArchiveTool" },
    });
    expect(screen.getByText("Quiet Feature")).toBeTruthy();
    expect(screen.queryByText("Shelves")).toBeNull();

    // Search unmatched
    fireEvent.change(screen.getByLabelText("Search products and features"), {
      target: { value: "nonexistent" },
    });
    expect(
      screen.getByText("No matching products or features found"),
    ).toBeTruthy();
  });

  it("displays read-only counts separated root/child and navigates to related tasks", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "catalog") return catalogState;
      return {};
    });
    const toThread = vi.fn();

    render(
      <Catalog
        rpc={{ call } as never}
        threads={[
          { id: "t-root", displayTitle: "Root Task Alpha" } as never,
          { id: "t-child", displayTitle: "Child Task Beta" } as never,
        ]}
        navigate={{ toThread }}
      />,
    );

    // Separated read-only counts: 1 root, 1 child
    expect(await screen.findByText("1 root, 1 child")).toBeTruthy();

    // Click to show related tasks
    const showTasksBtn = screen.getByRole("button", {
      name: "Show related tasks",
    });
    fireEvent.click(showTasksBtn);

    // Verify task list
    const rootTaskItem = await screen.findByRole("button", {
      name: "Root Task Alpha",
    });
    const childTaskItem = screen.getByRole("button", {
      name: "Child Task Beta",
    });
    expect(screen.getByText("root task")).toBeTruthy();
    expect(screen.getByText("child (inherited)")).toBeTruthy();

    // Click to navigate
    fireEvent.click(rootTaskItem);
    expect(toThread).toHaveBeenCalledWith("t-root");

    fireEvent.click(childTaskItem);
    expect(toThread).toHaveBeenCalledWith("t-child");
  });

  it("creates a new entity with parent and aliases", async () => {
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
    fireEvent.click(
      screen.getByRole("button", { name: /New product or feature/i }),
    );

    expect(screen.getByText("New Product or Feature")).toBeTruthy();
    fireEvent.change(
      screen.getByPlaceholderText("e.g. Workstreams, Catalog, Billing"),
      {
        target: { value: "Settings" },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText("What does this product or feature concern?"),
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

    fireEvent.click(
      screen.getByRole("button", { name: /New product or feature/i }),
    );
    fireEvent.change(
      screen.getByPlaceholderText("e.g. Workstreams, Catalog, Billing"),
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

  it("renames an entity through the UI without native rename", async () => {
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
    expect(screen.getByText("Rename Entity")).toBeTruthy();

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

  it("reparents an entity in the hierarchy and handles cycle errors", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Reparent Lantern" }));
    expect(screen.getByText("Reparent Entity")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reparent" }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith("catalogReparent", {
        entityId: "p",
        parentId: null,
      });
    });
  });

  it("merges an entity and preserves references", async () => {
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
      screen.getByRole("button", { name: "Merge Shelves into another entity" }),
    );
    expect(screen.getByText("Merge Entity")).toBeTruthy();

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

  it("edits metadata (description and aliases)", async () => {
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
      screen.getByRole("button", { name: "Edit metadata for Shelves" }),
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
    expect(
      await screen.findByText("No products or features have been recorded yet"),
    ).toBeTruthy();
  });
});
