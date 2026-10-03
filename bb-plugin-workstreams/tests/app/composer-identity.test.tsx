// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { NewWorkDialog } from "../../src/app/composer/NewWork.tsx";
import { emptyState } from "./fixtures.ts";
import type { RouteDecision } from "../../src/server/router.ts";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

const sampleDecision: RouteDecision = {
  id: "d_1",
  outcome: "new-thread",
  sectionId: "sec_a",
  workstream: "Alpha",
  title: "",
  placement: null,
  confidence: "high",
  reason: "Fits Alpha",
  subject: "Sidebar",
  subjectId: "ent_sidebar",
  traceId: "tr_1",
};

function mount(decision: RouteDecision = sampleDecision) {
  const onClose = vi.fn();
  const rpc = {
    prefs: vi.fn(() => ({
      prefs: {
        newWork: {
          suggestions: true,
          suggestionsModel: { kind: "gateway", model: "m" },
        },
      },
    })),
    state: vi.fn(() => ({
      ...emptyState(),
      workstreams: {
        sec_a: { sectionId: "sec_a", name: "Alpha" },
        sec_b: { sectionId: "sec_b", name: "Beta" },
      },
    })),
    catalog: vi.fn(() => ({
      entities: [
        {
          id: "ent_storage",
          name: "Storage",
          description: "Storage product",
          parentId: null,
          aliases: ["Warehouse"],
        },
        {
          id: "ent_shelves",
          name: "Shelves",
          description: "Shelves feature",
          parentId: "ent_storage",
          aliases: ["Racks"],
        },
        {
          id: "ent_sidebar",
          name: "Sidebar",
          description: "Navigation sidebar",
          parentId: null,
          aliases: [],
        },
      ],
    })),
    catalogResolve: vi.fn((_input: unknown) => ({
      sectionId: "sec_a",
      name: "Alpha",
    })),
    route: vi.fn((_input: unknown) => decision),
    routeCancel: vi.fn((_input: unknown) => ({ canceled: true })),
    startThread: vi.fn((_input: unknown) => ({
      threadId: "thr_new",
      sectionId: "sec_a",
    })),
    sendToThread: vi.fn((_input: unknown) => ({ threadId: "thr_p" })),
    createWorkstream: vi.fn(async (input: { name: string } | unknown) => ({
      sectionId: "sec_new",
      entry: {
        workstreams: [
          {
            id: "sec_new",
            name:
              typeof input === "object" && input !== null && "name" in input
                ? String((input as any).name)
                : "New",
          },
        ],
      },
    })),
  };

  const slot = renderSlot(
    { component: NewWorkDialog },
    { open: true, onClose },
    {
      settings: {},
      composer: { scope: { kind: "new-thread", projectId: "proj_z" } },
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", name: "bb", kind: "standard" },
            { id: "proj_personal", name: "Personal", kind: "personal" },
          ],
        },
      } as unknown as PluginBrowserBbSdk,
      rpc,
    },
  );

  return { slot, rpc, onClose };
}

describe("Composer Identity & Placement Separation UI", () => {
  it("renders two compact independently actionable controls", async () => {
    mount();
    const identityControl = await screen.findByRole("button", {
      name: /Product or feature:/,
    });
    const workstreamControl = await screen.findByRole("button", {
      name: /Workstream:/,
    });

    expect(identityControl).toBeDefined();
    expect(workstreamControl).toBeDefined();
    expect(identityControl.getAttribute("data-ws-identity-control")).toBe("");
    expect(workstreamControl.getAttribute("data-ws-workstream-control")).toBe(
      "",
    );
  });

  it("changing placement does not erase selected identity", async () => {
    const { rpc } = mount();

    // 1. Pick an identity explicitly
    const identityButton = await screen.findByRole("button", {
      name: /Product or feature:/,
    });
    fireEvent.click(identityButton);

    const identitySearch = await screen.findByRole("combobox", {
      name: "Search products and features",
    });
    // Search by ancestor name "Storage" to find child "Shelves"
    fireEvent.change(identitySearch, { target: { value: "Storage" } });
    const shelvesOption = await screen.findByText("Storage: Shelves");
    fireEvent.click(shelvesOption);

    // Verify identity button updated to selected feature
    await screen.findByRole("button", {
      name: "Product or feature: Storage: Shelves",
    });

    // 2. Change placement explicitly to Beta
    const workstreamButton = await screen.findByRole("button", {
      name: /Workstream:/,
    });
    fireEvent.click(workstreamButton);

    const betaOption = await screen.findByText("Beta");
    fireEvent.click(betaOption);

    // Verify placement updated to Beta
    await screen.findByRole("button", { name: "Workstream: Beta" });

    // Verify identity is STILL Storage: Shelves! Not erased!
    await screen.findByRole("button", {
      name: "Product or feature: Storage: Shelves",
    });

    // 3. Submit and verify startThread receives both
    fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(rpc.startThread).toHaveBeenCalledTimes(1));

    expect(rpc.startThread.mock.calls[0]![0]).toMatchObject({
      sectionId: "sec_b",
      identity: {
        entityId: "ent_shelves",
        provenance: "manual",
      },
    });
  });

  it("manual identity does not force a move of manual placement", async () => {
    mount();

    // 1. Pick Beta as manual placement
    const workstreamButton = await screen.findByRole("button", {
      name: /Workstream:/,
    });
    fireEvent.click(workstreamButton);
    fireEvent.click(await screen.findByText("Beta"));
    await screen.findByRole("button", { name: "Workstream: Beta" });

    // 2. Pick identity Sidebar
    const identityButton = await screen.findByRole("button", {
      name: /Product or feature:/,
    });
    fireEvent.click(identityButton);
    fireEvent.click(await screen.findByText("Sidebar"));

    // Placement must REMAIN Beta! Manual identity must not force a move!
    await screen.findByRole("button", { name: "Workstream: Beta" });
    await screen.findByRole("button", {
      name: "Product or feature: Sidebar",
    });
  });

  it("manual unresolved selection is truthful, resists async suggestion overwrite, and submits honest null identity", async () => {
    const { rpc, slot } = mount();

    // Open identity picker and choose "Unresolved"
    const identityButton = await screen.findByRole("button", {
      name: /Product or feature:/,
    });
    fireEvent.click(identityButton);

    const unresolvedItem = await screen.findByText("Unresolved");
    fireEvent.click(unresolvedItem);

    // Verify identity button shows "Unresolved"
    await screen.findByRole("button", {
      name: "Product or feature: Unresolved",
    });

    // Reopen popover and verify aria-current and checkmarks
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Product or feature: Unresolved",
      }),
    );

    const unresolvedOption = screen.getByRole("option", {
      name: /Unresolved/,
    });
    expect(unresolvedOption.getAttribute("aria-current")).toBe("true");
    const unresolvedCheckmark = unresolvedOption.querySelector(
      '[data-icon="Check"]',
    );
    expect(unresolvedCheckmark?.classList.contains("opacity-100")).toBe(true);

    const automaticOption = screen.getByRole("option", {
      name: /Automatic/,
    });
    expect(automaticOption.getAttribute("aria-current")).toBeNull();
    const automaticCheckmark = automaticOption.querySelector(
      '[data-icon="Check"]',
    );
    expect(automaticCheckmark?.classList.contains("opacity-0")).toBe(true);

    // Close popover
    fireEvent.keyDown(document.body, { key: "Escape" });
    await act(() =>
      slot.behavior.setComposerText("New text to re-trigger classification"),
    );

    // Verify that state.identity remains manual Unresolved and does not get overwritten by automatic suggestion
    await screen.findByRole("button", {
      name: "Product or feature: Unresolved",
    });

    // Submit and assert startThread receives honest null entityId with provenance: "manual"
    fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(rpc.startThread).toHaveBeenCalledTimes(1));

    expect(rpc.startThread.mock.calls[0]![0]).toMatchObject({
      identity: {
        entityId: null,
        proposal: null,
        provenance: "manual",
      },
    });
  });
});
