// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { NewThreadRouting } from "../../src/app/composer/NewThreadRouting.tsx";
import { NewWorkDialog } from "../../src/app/composer/NewWork.tsx";
import { ChipLabel } from "../../src/app/composer/picker-options.tsx";
import type { RouteDecision } from "../../src/server/router.ts";
import { emptyState } from "./fixtures.ts";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

let restoreMatchMedia: (() => void) | null = null;
afterEach(() => {
  cleanup();
  restoreMatchMedia?.();
  restoreMatchMedia = null;
});

/**
 * jsdom has no `matchMedia`, so every query is false and the picker renders
 * its wide variant. A test that wants a phone makes the compact viewport
 * query match, as a 390px-wide screen does.
 */
function stubMatchMedia(matches: (query: string) => boolean) {
  const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  restoreMatchMedia = () => {
    if (original) Object.defineProperty(window, "matchMedia", original);
    else delete (window as { matchMedia?: unknown }).matchMedia;
  };
}
const phone = () => stubMatchMedia((query) => query === "(max-width: 767px)");

const alphaDecision: RouteDecision = {
  id: "route-alpha",
  traceId: "trace-alpha",
  confidence: "high",
  reason: "Belongs in Alpha",
  subject: "Sidebar",
  subjectId: "ent_sidebar",
  outcome: "new-thread",
  sectionId: "section-alpha",
  workstream: "Alpha",
  title: "",
  placement: null,
};
const newWorkstreamDecision: RouteDecision = {
  id: "route-billing",
  traceId: "trace-billing",
  confidence: "high",
  reason: "A new effort",
  subject: null,
  outcome: "new-workstream",
  name: "Billing",
  description: "Invoices",
  title: "Invoice export",
  placement: null,
};
const continuationDecision: RouteDecision = {
  id: "route-continuation",
  traceId: "trace-continuation",
  confidence: "high",
  reason: "Continues the parser fix",
  subject: null,
  outcome: "continue",
  threadId: "thread-parser",
  threadTitle: "Parser fix",
  workstream: "Alpha",
  sectionId: "section-alpha",
};
const unsureDecision: RouteDecision = {
  id: "route-unsure",
  traceId: "trace-unsure",
  confidence: "low",
  reason: "Could be anything",
  subject: null,
  outcome: "unsure",
  candidates: [],
};

const WORKSTREAMS = {
  alpha: {
    sectionId: "section-alpha",
    name: "Alpha",
    description: "Adaptive grouping for threads",
  },
  beta: { sectionId: "section-beta", name: "Beta", description: null },
};
const CATALOG = [
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
    description: "Shelving feature",
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
];

/** BB's composer as the picker sees it: the prompt box, a host form, and a picker row. */
function RowComposer() {
  const composer = useComposer();
  return (
    <main data-app-composer-role="primary">
      <div data-promptbox-shell="">
        <NewThreadRouting />
        <form
          data-promptbox=""
          onSubmit={(event) => {
            event.preventDefault();
            void composer.submit({ experimental_data: null });
          }}
        >
          <button type="submit">Host submit</button>
        </form>
        <div>
          <div>
            <button type="button" data-promptbox-project-control="">
              Project
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

/** A composer whose markup has no picker row, so the field renders itself. */
function BareComposer() {
  return (
    <main data-app-composer-role="primary">
      <NewThreadRouting />
    </main>
  );
}

function mount(
  options: {
    decision?: RouteDecision;
    component?: React.ComponentType;
    workstreams?: Record<string, unknown>;
  } = {},
) {
  const decision = options.decision ?? unsureDecision;
  const route = vi.fn(async () => decision);
  const catalogResolve = vi.fn(async (_input: unknown) => ({
    sectionId: "section-alpha",
    name: "Alpha",
  }));
  const createWorkstream = vi.fn(async (input: unknown) => ({
    sectionId: "section-created",
    entry: {
      workstreams: [
        { id: "section-created", name: (input as { name: string }).name },
      ],
    },
  }));
  const slot = renderSlot(
    { component: options.component ?? RowComposer },
    {},
    {
      composer: {
        text: "",
        attachments: [],
        scope: { kind: "new-thread", projectId: "project-alpha" },
        selection: { projectId: "project-alpha" },
      },
      sdk: {
        projects: {
          list: async () => [],
          attachments: { copy: async () => {} },
        },
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            projectId: "project-alpha",
            archivedAt: null,
          }),
        },
      } as never,
      rpc: {
        prefs: async () => ({ prefs: {} }),
        state: async () => ({
          ...emptyState(),
          workstreams: options.workstreams ?? WORKSTREAMS,
          order: { workstreams: [], threads: {}, prioritized: [] },
        }),
        catalog: async () => ({ entities: CATALOG }),
        catalogResolve,
        route,
        routeCancel: async () => ({ canceled: true }),
        startThread: async () => ({ threadId: "thread-created" }),
        sendToThread: async () => ({ threadId: "thread-parser" }),
        createWorkstream,
      } as never,
    },
  );
  return { slot, route, catalogResolve, createWorkstream };
}

const PROMPT = "Fix the parser in Alpha so it handles tabs";

async function classify(slot: ReturnType<typeof mount>["slot"]) {
  await act(() => slot.behavior.setComposerText(PROMPT));
}

const routeChip = (name: string | RegExp = /^Route: /) =>
  screen.findByRole("button", { name });

async function openSheet() {
  fireEvent.click(await routeChip());
  return screen.findByRole("tablist", { name: "Route" });
}

describe("the picker on a phone", () => {
  it("renders one route chip in place of the two chips", async () => {
    phone();
    mount();
    const chip = await routeChip();
    expect(chip.getAttribute("aria-label")).toBe(
      "Route: Workstream Automatic, Product or feature Automatic",
    );
    expect(screen.getAllByRole("button", { name: /^Route: / })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Workstream: / })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Product or feature: / }),
    ).toBeNull();
    expect(document.querySelector("[data-ws-identity-control]")).toBeNull();
    expect(document.querySelectorAll("[data-ws-route-control]")).toHaveLength(
      1,
    );
    expect(
      chip
        .closest("[data-ws-composer-controls]")
        ?.getAttribute("data-ws-variant"),
    ).toBe("route");
  });

  it("puts the chip at the start of BB's picker row, in a plugin-root anchor", async () => {
    phone();
    mount();
    const chip = await routeChip();
    const anchor = chip.closest("[data-ws-workstream-slot]");
    expect(anchor).toBeTruthy();
    // The row is BB's, outside any plugin root, where the plugin's scoped
    // utility classes would otherwise not apply.
    expect(anchor!.hasAttribute("data-bb-plugin-root")).toBe(true);
    expect(
      anchor!.compareDocumentPosition(
        document.querySelector("[data-promptbox-project-control]")!,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the same chip in the fallback row when BB's picker row isn't found", async () => {
    phone();
    mount({ component: BareComposer });
    const chip = await routeChip();
    expect(chip.closest("[data-ws-workstream-slot]")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Route: / })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Workstream: / })).toBeNull();
  });

  it("marks an Automatic destination with ✦ and the tint attributes", async () => {
    phone();
    const { slot } = mount({ decision: alphaDecision });
    const chip = await routeChip();
    expect(chip.dataset.wsAuto).toBe("true");
    expect(chip.dataset.wsDestination).toBeUndefined();
    expect(chip.querySelector(".ws-spark")).toBeTruthy();

    await classify(slot);
    const classified = await routeChip(
      "Route: Workstream Alpha, Product or feature Sidebar",
    );
    expect(classified.dataset.wsAuto).toBe("true");
    expect(classified.dataset.wsDestination).toBe("true");
    expect(classified.querySelector(".ws-spark")).toBeTruthy();
    // The existing tint and pulse rules key on the Workstream field's marker.
    expect(classified.hasAttribute("data-ws-workstream-control")).toBe(true);
  });

  it("shows a proposed workstream as the automatic destination", async () => {
    phone();
    const { slot } = mount({ decision: newWorkstreamDecision });
    await classify(slot);
    const chip = await routeChip(
      "Route: Workstream Billing, Product or feature Automatic",
    );
    expect(chip.dataset.wsAuto).toBe("true");
    expect(chip.dataset.wsDestination).toBe("true");
  });

  it("drops the tint and shows the muted workstream mark for a pinned pick", async () => {
    phone();
    mount();
    await openSheet();
    fireEvent.click(await screen.findByRole("option", { name: /^Beta/ }));
    const chip = await routeChip(
      "Route: Workstream Beta, Product or feature Automatic",
    );
    expect(chip.dataset.wsAuto).toBeUndefined();
    expect(chip.dataset.wsDestination).toBe("true");
    expect(chip.querySelector(".ws-spark")).toBeNull();
    expect(
      chip.querySelector('[data-icon="workstreams/workstream"]'),
    ).toBeTruthy();
  });

  it("shows No workstream with the dotted mark", async () => {
    phone();
    mount();
    await openSheet();
    fireEvent.click(
      await screen.findByRole("option", { name: "No workstream" }),
    );
    const chip = await routeChip(
      "Route: Workstream No workstream, Product or feature Automatic",
    );
    expect(chip.dataset.wsAuto).toBeUndefined();
    expect(chip.dataset.wsDestination).toBeUndefined();
    expect(
      chip.querySelector('[data-icon="workstreams/workstream-none"]'),
    ).toBeTruthy();
  });

  it("marks the status text sr-only so it takes no width in the row", async () => {
    phone();
    mount();
    await routeChip();
    const status = document.querySelector(
      '[data-ws-workstream-slot] [role="status"]',
    );
    expect(status).toBeTruthy();
    expect(status!.classList.contains("sr-only")).toBe(true);
    expect(status!.classList.contains("ws-picker-status")).toBe(false);
  });
});

describe("the route sheet", () => {
  it("opens one sheet with a Workstream tab selected and a Product or feature tab", async () => {
    phone();
    mount();
    const tablist = await openSheet();
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ]);
    expect(tabs[0]!.textContent).toBe("Workstream✦Automatic");
    expect(tabs[1]!.textContent).toBe("Product or feature✦Automatic");
    expect(tabs[0]!.dataset.wsRouteTab).toBe("workstream");
    expect(tabs[1]!.dataset.wsRouteTab).toBe("identity");
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0]!.id);
    expect(tabs[0]!.getAttribute("aria-controls")).toBe(panel.id);
    // The selected tab shows today's workstream list.
    expect(
      within(panel).getByPlaceholderText("Find or create a workstream"),
    ).toBeTruthy();
    expect(
      within(panel)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Automatic"),
        expect.stringContaining("Alpha"),
        expect.stringContaining("Beta"),
        expect.stringContaining("No workstream"),
      ]),
    );
    // Only the chip opened it: one dialog, one list.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
  });

  it("lists Automatic first, then workstreams with descriptions, then known products", async () => {
    phone();
    mount();
    await openSheet();
    expect(
      await screen.findByText("Adaptive grouping for threads"),
    ).toBeTruthy();
    const options = screen.getAllByRole("option");
    expect(options[0]!.textContent).toContain("Automatic");
    expect(options[options.length - 1]!.textContent).toContain("No workstream");
    // The Catalog loads when the sheet opens.
    expect(await screen.findByText("Known products and features")).toBeTruthy();
    expect(screen.getByText("Storage: Shelves")).toBeTruthy();
  });

  it("switches lists by tap and moves between tabs with the arrow keys", async () => {
    phone();
    mount();
    const tablist = await openSheet();
    const [workstreamTab, identityTab] = within(tablist).getAllByRole("tab");

    fireEvent.click(identityTab!);
    expect(identityTab!.getAttribute("aria-selected")).toBe("true");
    expect(workstreamTab!.getAttribute("aria-selected")).toBe("false");
    expect(
      screen.getByPlaceholderText("Find a product or feature"),
    ).toBeTruthy();
    expect(
      screen.queryByPlaceholderText("Find or create a workstream"),
    ).toBeNull();
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      identityTab!.id,
    );
    // Only the selected tab is in the tab order.
    expect(identityTab!.tabIndex).toBe(0);
    expect(workstreamTab!.tabIndex).toBe(-1);

    fireEvent.keyDown(identityTab!, { key: "ArrowLeft" });
    expect(workstreamTab!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(workstreamTab);
    fireEvent.keyDown(workstreamTab!, { key: "ArrowRight" });
    expect(identityTab!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(identityTab);
    fireEvent.keyDown(identityTab!, { key: "ArrowRight" });
    expect(workstreamTab!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(workstreamTab!, { key: "End" });
    expect(identityTab!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(identityTab!, { key: "Home" });
    expect(workstreamTab!.getAttribute("aria-selected")).toBe("true");
  });

  it("applies a picked workstream through the model and closes the sheet", async () => {
    phone();
    const { slot } = mount({ decision: alphaDecision });
    await openSheet();
    fireEvent.click(await screen.findByRole("option", { name: /^Beta/ }));

    await routeChip("Route: Workstream Beta, Product or feature Automatic");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(
      document
        .querySelector("[data-persistent-drawer-content]")
        ?.getAttribute("data-state"),
    ).toBe("closed");

    // The same destination the desktop control would file.
    await act(() => slot.behavior.setComposerText(PROMPT));
    fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
    await waitFor(() =>
      expect(slot.inspection.composer.submits).toHaveLength(1),
    );
    expect(slot.inspection.composer.submits[0]).toEqual({
      experimental_data: { sectionId: "section-beta" },
    });
  });

  it("sets the Product or feature from its tab without moving the workstream", async () => {
    phone();
    const { slot } = mount();
    await openSheet();
    fireEvent.click(await screen.findByRole("option", { name: /^Beta/ }));
    fireEvent.click(await routeChip());
    const tablist = await screen.findByRole("tablist");
    fireEvent.click(within(tablist).getAllByRole("tab")[1]!);
    fireEvent.click(
      await screen.findByRole("option", { name: /Storage: Shelves/ }),
    );

    await routeChip(
      "Route: Workstream Beta, Product or feature Storage: Shelves",
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    await act(() => slot.behavior.setComposerText(PROMPT));
    fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
    await waitFor(() =>
      expect(slot.inspection.composer.submits).toHaveLength(1),
    );
    expect(slot.inspection.composer.submits[0]).toEqual({
      experimental_data: {
        sectionId: "section-beta",
        identity: {
          entityId: "ent_shelves",
          proposal: null,
          provenance: "manual",
        },
      },
    });
  });

  it("creates a workstream by name from the search", async () => {
    phone();
    const { createWorkstream } = mount();
    await openSheet();
    fireEvent.change(
      screen.getByPlaceholderText("Find or create a workstream"),
      {
        target: { value: "Payments" },
      },
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "New workstream “Payments”" }),
    );
    await routeChip("Route: Workstream Payments, Product or feature Automatic");
    expect(createWorkstream).toHaveBeenCalledWith({ name: "Payments" });
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("files a known product or feature into the workstream the Catalog resolves", async () => {
    phone();
    const { catalogResolve } = mount();
    await openSheet();
    fireEvent.click(await screen.findByRole("option", { name: /Sidebar/ }));
    await routeChip("Route: Workstream Alpha, Product or feature Sidebar");
    expect(catalogResolve).toHaveBeenCalledWith({ entityId: "ent_sidebar" });
  });

  it("returns to Automatic from either tab", async () => {
    phone();
    const { slot } = mount({ decision: alphaDecision });
    await classify(slot);
    await routeChip("Route: Workstream Alpha, Product or feature Sidebar");

    await openSheet();
    fireEvent.click(await screen.findByRole("option", { name: /^Beta/ }));
    await routeChip("Route: Workstream Beta, Product or feature Sidebar");
    fireEvent.click(await routeChip());
    fireEvent.click(await screen.findByRole("option", { name: /^Automatic/ }));
    // Automatic again: the classifier's home returns and the pickers unpin.
    const chip = await routeChip(/^Route: Workstream Alpha/);
    expect(chip.dataset.wsAuto).toBe("true");
  });

  it("reopens on the Workstream tab with an empty search", async () => {
    phone();
    mount();
    let tablist = await openSheet();
    fireEvent.click(within(tablist).getAllByRole("tab")[1]!);
    fireEvent.change(screen.getByPlaceholderText("Find a product or feature"), {
      target: { value: "side" },
    });
    // Close from the backdrop, as a tap outside the sheet does.
    fireEvent.click(
      document.querySelector("[data-persistent-drawer-backdrop]")!,
    );
    await waitFor(() => expect(screen.queryByRole("tablist")).toBeNull());

    fireEvent.click(await routeChip());
    tablist = await screen.findByRole("tablist");
    expect(
      within(tablist).getAllByRole("tab")[0]!.getAttribute("aria-selected"),
    ).toBe("true");
    const search = screen.getByPlaceholderText(
      "Find or create a workstream",
    ) as HTMLInputElement;
    expect(search.value).toBe("");
    fireEvent.click(within(tablist).getAllByRole("tab")[1]!);
    expect(
      (
        screen.getByPlaceholderText(
          "Find a product or feature",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
  });

  it("sizes the search and rows for a finger", async () => {
    phone();
    mount();
    await openSheet();
    const search = screen.getByPlaceholderText("Find or create a workstream");
    // The base text token is 16px on a phone, which keeps iOS from zooming.
    expect(search.classList.contains("text-base")).toBe(true);
    expect(search.classList.contains("h-11")).toBe(true);
    for (const option of screen.getAllByRole("option")) {
      expect(option.classList.contains("pointer-coarse:min-h-11")).toBe(true);
    }
  });

  describe("the classifier's reason", () => {
    it("is stated for an automatic destination, since touch has no tooltip", async () => {
      phone();
      const { slot } = mount({ decision: alphaDecision });
      await classify(slot);
      await routeChip(/^Route: Workstream Alpha/);
      await openSheet();
      const note = document.querySelector("[data-ws-route-note]");
      expect(note?.textContent).toContain("Belongs in Alpha");
      // It belongs to the workstream, so the other tab leaves it out.
      fireEvent.click(screen.getAllByRole("tab")[1]!);
      expect(document.querySelector("[data-ws-route-note]")).toBeNull();
    });

    it("falls back to what Automatic means before anything is classified", async () => {
      phone();
      mount();
      await openSheet();
      expect(
        document.querySelector("[data-ws-route-note]")?.textContent,
      ).toContain("The classifier files this as you type");
    });

    it("adds that a proposed workstream is created when you start", async () => {
      phone();
      const { slot } = mount({ decision: newWorkstreamDecision });
      await classify(slot);
      await routeChip(/^Route: Workstream Billing/);
      await openSheet();
      const note = document.querySelector("[data-ws-route-note]");
      expect(
        [...note!.querySelectorAll("p")].map((line) => line.textContent),
      ).toEqual([
        "A new effort",
        "New workstream “Billing” — created when you start",
      ]);
    });

    it("is left out once the destination is a manual pick", async () => {
      phone();
      mount();
      await openSheet();
      fireEvent.click(await screen.findByRole("option", { name: /^Beta/ }));
      fireEvent.click(await routeChip());
      await screen.findByRole("tablist");
      expect(document.querySelector("[data-ws-route-note]")).toBeNull();
    });
  });
});

describe("the picker on a wide screen", () => {
  it("still renders the two chips, never the route chip", async () => {
    mount();
    const identity = await screen.findByRole("button", {
      name: "Product or feature: Automatic",
    });
    const workstream = await screen.findByRole("button", {
      name: "Workstream: Automatic",
    });
    expect(screen.queryByRole("button", { name: /^Route: / })).toBeNull();
    expect(document.querySelector("[data-ws-route-control]")).toBeNull();
    expect(identity.hasAttribute("data-ws-identity-control")).toBe(true);
    expect(workstream.hasAttribute("data-ws-workstream-control")).toBe(true);
    expect(
      workstream
        .closest("[data-ws-composer-controls]")
        ?.getAttribute("data-ws-variant"),
    ).toBe("split");
  });

  it("keeps the status text visible and shrinkable", async () => {
    const { slot } = mount({ decision: alphaDecision });
    await classify(slot);
    const status = document.querySelector(
      '[data-ws-workstream-slot] [role="status"]',
    );
    expect(status!.classList.contains("sr-only")).toBe(false);
    expect(status!.classList.contains("ws-picker-status")).toBe(true);
  });

  it("opens each chip's own popover rather than the route sheet", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Product or feature: Automatic",
      }),
    );
    expect(
      await screen.findByPlaceholderText("Find a product or feature"),
    ).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("gives the lists their desktop sizing", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Workstream: Automatic" }),
    );
    const search = await screen.findByPlaceholderText(
      "Find or create a workstream",
    );
    expect(search.classList.contains("text-xs")).toBe(true);
    expect(search.classList.contains("h-8")).toBe(true);
    expect(
      screen
        .getAllByRole("option")
        .some((o) => o.classList.contains("pointer-coarse:min-h-11")),
    ).toBe(false);
  });
});

describe("the suggestion row on touch", () => {
  it("carries the classes the touch layout hides and enlarges", async () => {
    phone();
    const { slot } = mount({ decision: alphaDecision });
    await classify(slot);
    // Pinning keeps the suggestion's row for a manual acceptance.
    await openSheet();
    fireEvent.click(
      await screen.findByRole("option", { name: "No workstream" }),
    );
    const start = await screen.findByRole("button", {
      name: "Apply and start the thread",
    });
    const row = start.closest(".ws-suggestion")!;
    expect(row.closest(".ws-suggestion-area")).toBeTruthy();
    // Hidden on touch: the Tab-key Apply button and every key hint.
    expect(row.querySelector(".ws-suggestion-apply")).toBeTruthy();
    expect(row.querySelectorAll(".ws-suggestion-kbd").length).toBe(2);
    // Kept: the sentence, the Start action and the dismiss button.
    expect(row.querySelector(".ws-suggestion-accept")).toBeTruthy();
    expect(start.classList.contains("ws-suggestion-go")).toBe(true);
    expect(start.textContent).toContain("Start");
    expect(row.querySelector(".ws-suggestion-dismiss")).toBeTruthy();
    expect(row.querySelector(".ws-suggestion-text")).toBeTruthy();
  });

  it("offers Send for a thread suggestion with no Apply button", async () => {
    phone();
    const { slot } = mount({ decision: continuationDecision });
    await classify(slot);
    const send = await screen.findByRole("button", {
      name: "Send to Parser fix",
    });
    const row = send.closest(".ws-suggestion")!;
    expect(send.classList.contains("ws-suggestion-go")).toBe(true);
    expect(send.textContent).toContain("Send");
    expect(row.querySelector(".ws-suggestion-apply")).toBeNull();
  });
});

describe("the picker in the New work dialog on a phone", () => {
  function mountDialog() {
    const startThread = vi.fn(async (_input: unknown) => ({
      threadId: "thread-created",
      sectionId: "section-beta",
    }));
    const slot = renderSlot(
      { component: NewWorkDialog },
      { open: true, onClose: vi.fn() },
      {
        settings: {},
        composer: { scope: { kind: "new-thread", projectId: "project-alpha" } },
        sdk: { projects: { list: async () => [] } } as never,
        rpc: {
          prefs: async () => ({ prefs: {} }),
          state: async () => ({
            ...emptyState(),
            workstreams: WORKSTREAMS,
            order: { workstreams: [], threads: {}, prioritized: [] },
          }),
          catalog: async () => ({ entities: CATALOG }),
          route: async () => unsureDecision,
          routeCancel: async () => ({ canceled: true }),
          startThread,
        } as never,
      },
    );
    return { slot, startThread };
  }

  it("renders the same single chip, and filing from its sheet reaches startThread", async () => {
    phone();
    const { slot, startThread } = mountDialog();
    const chip = await routeChip();
    expect(screen.getAllByRole("button", { name: /^Route: / })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Workstream: / })).toBeNull();
    expect(
      chip
        .closest("[data-ws-composer-controls]")
        ?.getAttribute("data-ws-variant"),
    ).toBe("route");

    fireEvent.click(chip);
    fireEvent.click(await screen.findByRole("option", { name: /^Beta/ }));
    await routeChip("Route: Workstream Beta, Product or feature Automatic");
    await act(() => slot.behavior.setComposerText(PROMPT));
    fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(startThread).toHaveBeenCalledTimes(1));
    expect(startThread.mock.calls[0]![0]).toMatchObject({
      sectionId: "section-beta",
    });
  });
});

describe("a chip label with no room left", () => {
  const sizes = { scroll: 0, client: 0 };
  const observers: (() => void)[] = [];
  const originalObserver = globalThis.ResizeObserver;
  const scrollWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollWidth",
  );
  const clientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );

  function fakeLayout() {
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get: () => sizes.scroll,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => sizes.client,
    });
  }
  const resize = (scroll: number, client: number) => {
    sizes.scroll = scroll;
    sizes.client = client;
    act(() => observers.forEach((callback) => callback()));
  };

  afterEach(() => {
    globalThis.ResizeObserver = originalObserver;
    observers.length = 0;
    if (scrollWidth)
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", scrollWidth);
    if (clientWidth)
      Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
  });

  it("is hidden once a truncated label has less than an ellipsis of room, and shown again with more", () => {
    fakeLayout();
    sizes.scroll = 120;
    sizes.client = 10;
    const { container } = render(<ChipLabel>Concerning: Automatic</ChipLabel>);
    const label = container.firstElementChild!;
    expect(label.hasAttribute("data-ws-label-tiny")).toBe(true);
    // The text is still there for the chip's accessible name to match.
    expect(label.textContent).toBe("Concerning: Automatic");

    resize(120, 60);
    expect(label.hasAttribute("data-ws-label-tiny")).toBe(false);
    resize(120, 6);
    expect(label.hasAttribute("data-ws-label-tiny")).toBe(true);
  });

  it("never hides a label that fits, however short it is", () => {
    fakeLayout();
    sizes.scroll = 14;
    sizes.client = 14;
    const { container } = render(<ChipLabel>AI</ChipLabel>);
    expect(
      container.firstElementChild!.hasAttribute("data-ws-label-tiny"),
    ).toBe(false);
  });
});
