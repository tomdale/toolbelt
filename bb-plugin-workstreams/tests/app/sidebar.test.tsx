// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, section, sidebarThread } from "./fixtures.ts";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const sections = [
  section("sec_a", "Alpha"),
  section("sec_b", "Beta"),
  section("sec_z", "Zeta"),
];

async function mount(
  threads = [
    sidebarThread("root", { sectionId: "sec_a", title: "Root task" }),
    sidebarThread("kid", {
      parentThreadId: "root",
      sectionId: "sec_b",
      title: "Kid task",
    }),
    sidebarThread("beta", { sectionId: "sec_b", title: "Beta task" }),
    sidebarThread("loose", { title: "Loose task" }),
    sidebarThread("hidden", { isHidden: true, title: "Hidden helper" }),
  ],
  options: {
    settings?: Record<string, boolean>;
    spinner?: unknown;
    onNavigate?: () => void;
    analysis?: Record<string, unknown>;
    order?: { workstreams: string[]; threads: Record<string, string[]> };
  } = {},
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const list = app.threadLists[0]!;
  return renderSlot(
    list,
    {
      activeThreadId: "beta",
      activeProjectId: null,
      isCompactViewport: false,
      onNavigate: options.onNavigate ?? (() => undefined),
      searchQuery: "",
    },
    {
      sidebarThreads: { status: "ready", threads, sections, projects: [] },
      settings: options.settings ?? {},
      rpc: {
        state: () => ({
          ...emptyState(),
          analysis: options.analysis ?? {},
          order: options.order ?? { workstreams: [], threads: {} },
        }),
        moveThread: () => ({ entry: null }),
        spinner: () => ({
          spinner: options.spinner ?? {
            shape: "spokes",
            primary: "subtle",
            secondary: "auto",
          },
        }),
        reorder: (raw: unknown) => {
          const input = raw as {
            kind: string;
            groupId?: string;
            ids: string[];
          };
          return {
            order:
              input.kind === "workstreams"
                ? { workstreams: input.ids, threads: {} }
                : { workstreams: [], threads: { [input.groupId!]: input.ids } },
          };
        },
      },
    },
  );
}

const groupRows = (slot: Awaited<ReturnType<typeof mount>>, name: string) =>
  within(slot.getByRole("region", { name }))
    .getAllByRole("link")
    .map((a) => a.getAttribute("aria-label"));

describe("thread list", () => {
  it("groups whole trees by the root's workstream and hides hidden threads", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    expect(groupRows(slot, "Alpha")).toEqual(["Root task", "Kid task"]);
    expect(groupRows(slot, "Beta")).toEqual(["Beta task"]);
    expect(groupRows(slot, "Unsorted")).toEqual(["Loose task"]);
    expect(slot.queryByText("Hidden helper")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps empty workstreams in a collapsed Dormant fold", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const dormant = slot.getByRole("button", { name: /Dormant/ });
    expect(dormant.getAttribute("aria-expanded")).toBe("false");
    expect(slot.queryByRole("region", { name: "Zeta" })).toBeNull();
    fireEvent.click(dormant);
    expect(slot.getByRole("region", { name: "Zeta" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("renders rows as shortcut-target anchors that open threads", async () => {
    let navigated = 0;
    const slot = await mount(undefined, {
      settings: { showRecent: false },
      onNavigate: () => navigated++,
    });
    const link = within(slot.getByRole("region", { name: "Alpha" })).getByRole(
      "link",
      {
        name: "Root task",
      },
    );
    expect(link.getAttribute("data-sidebar-thread-shortcut-target")).toBe("");
    expect(link.getAttribute("data-sidebar-thread-id")).toBe("root");
    expect(link.getAttribute("href")).toBe("/projects/proj_1/threads/root");
    fireEvent.click(link, { metaKey: true });
    expect(slot.inspection.sidebarActionCalls.at(-1)).toMatchObject({
      method: "open",
    });
    expect(navigated).toBe(1);
    slot.lifecycle.unmount();
  });

  it("shows Needs you and Recent as overlays without removing group rows", async () => {
    const slot = await mount([
      sidebarThread("ask", {
        sectionId: "sec_a",
        title: "Asking task",
        hasPendingInteraction: true,
        indicator: "waiting-for-input",
      }),
      sidebarThread("other", { sectionId: "sec_b", title: "Other task" }),
    ]);
    expect(groupRows(slot, "Needs you")).toEqual(["Asking task"]);
    expect(groupRows(slot, "Recent")).toEqual(["Other task"]);
    expect(groupRows(slot, "Alpha")).toEqual(["Asking task"]);
    expect(
      within(slot.getByRole("region", { name: "Alpha" })).getByTitle(
        "1 needs you",
      ),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("persists collapse state per group", async () => {
    const first = await mount(undefined, { settings: { showRecent: false } });
    fireEvent.click(
      within(first.getByRole("region", { name: "Alpha" })).getByRole("button", {
        name: "Alpha",
      }),
    );
    expect(
      within(first.getByRole("region", { name: "Alpha" })).queryAllByRole(
        "link",
      ),
    ).toHaveLength(0);
    first.lifecycle.unmount();
    const second = await mount(undefined, { settings: { showRecent: false } });
    expect(
      within(second.getByRole("region", { name: "Alpha" })).queryAllByRole(
        "link",
      ),
    ).toHaveLength(0);
    second.lifecycle.unmount();
  });

  it("moves a root through the context menu", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const link = within(
      slot.getByRole("region", { name: "Unsorted" }),
    ).getByRole("link", {
      name: "Loose task",
    });
    fireEvent.contextMenu(link.closest("li")!);
    const move = await slot.findByRole("menuitem", {
      name: "Move to workstream",
    });
    fireEvent.keyDown(move, { key: "ArrowRight" });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Beta" }));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some((c) => c.method === "moveThread"),
      ).toBe(true),
    );
    const call = slot.inspection.rpcCalls.find(
      (c) => c.method === "moveThread",
    );
    expect(call?.input).toEqual({ threadId: "loose", sectionId: "sec_b" });
    slot.lifecycle.unmount();
  });

  it("does not offer to move a child on its own", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const link = within(slot.getByRole("region", { name: "Alpha" })).getByRole(
      "link",
      {
        name: "Kid task",
      },
    );
    fireEvent.contextMenu(link.closest("li")!);
    const item = await slot.findByRole("menuitem", {
      name: "Moves with its parent",
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    slot.lifecycle.unmount();
  });

  it("lists a current needs-decision result in Needs you, but not a stale one", async () => {
    const at = Date.now();
    const result = (revision: number) => ({
      recap: "Asked whether to ship.",
      state: "needs_decision",
      needsYou: "Ship it?",
      subject: null,
      drift: null,
      driftSectionId: null,
      revision,
      at,
      model: "m",
    });
    const slot = await mount(
      [
        sidebarThread("fresh", { title: "Fresh ask", latestAttentionAt: 100 }),
        sidebarThread("stale", { title: "Stale ask", latestAttentionAt: 200 }),
      ],
      { analysis: { fresh: result(100), stale: result(150) } },
    );
    const band = await slot.findByRole("region", { name: "Needs you" });
    // The section implies the decision, so its rows leave the mark out.
    expect(
      within(band)
        .getAllByRole("link")
        .map((a) => a.getAttribute("aria-label")),
    ).toEqual(["Fresh ask"]);
    expect(
      within(band).queryAllByRole("img", { name: "Needs your decision" }),
    ).toHaveLength(0);
    expect(
      within(slot.getByRole("region", { name: "Unsorted" })).getAllByRole(
        "img",
        { name: "Needs your decision" },
      ),
    ).toHaveLength(1);
    slot.lifecycle.unmount();
  });

  it("collapses Needs you and names each row's workstream", async () => {
    const at = Date.now();
    const asks = (revision: number) => ({
      recap: "Asked whether to ship.",
      state: "needs_decision",
      needsYou: "Ship it?",
      subject: null,
      drift: null,
      driftSectionId: null,
      revision,
      at,
      model: "m",
    });
    // The delegate's older question folds into its manager's newer one.
    const slot = await mount(
      [
        sidebarThread("manager", {
          sectionId: "sec_a",
          title: "Manager",
          latestAttentionAt: 200,
        }),
        sidebarThread("delegate", {
          parentThreadId: "manager",
          sectionId: "sec_a",
          title: "Delegate",
          latestAttentionAt: 100,
        }),
      ],
      {
        settings: { showRecent: false },
        analysis: { manager: asks(200), delegate: asks(100) },
      },
    );
    const band = await slot.findByRole("region", { name: "Needs you" });
    expect(within(band).getByText("Alpha")).toBeTruthy();
    fireEvent.click(within(band).getByRole("button", { name: /Needs you/ }));
    expect(within(band).queryAllByRole("link")).toHaveLength(0);
    fireEvent.click(within(band).getByRole("button", { name: /Needs you/ }));
    expect(within(band).getByText("Alpha")).toBeTruthy();
    expect(within(band).queryByText(/via/)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("draws the working indicator chosen in settings, and follows changes", async () => {
    const working = [
      sidebarThread("busy", { title: "Busy", indicator: "runtime" }),
    ];
    const markOf = (slot: Awaited<ReturnType<typeof mount>>) =>
      within(slot.getByRole("region", { name: "Unsorted" })).getByRole("img", {
        name: "Working",
      });
    const byDefault = await mount(working, {
      settings: { showRecent: false },
    });
    expect(markOf(byDefault).className).toContain("ws-spin-spokes");
    byDefault.lifecycle.unmount();
    const picked = await mount(working, {
      settings: { showRecent: false },
      spinner: { shape: "orbit", primary: "green", secondary: "none" },
    });
    await waitFor(() =>
      expect(markOf(picked).className).toContain("ws-spin-orbit"),
    );
    expect(markOf(picked).style.getPropertyValue("--ws-spin-track")).toBe(
      "transparent",
    );
    await picked.behavior.emitRealtime("spinner", {
      spinner: { shape: "dots", primary: "#ff0000", secondary: "auto" },
    });
    expect(markOf(picked).className).toContain("ws-spin-dots");
    expect(markOf(picked).style.getPropertyValue("--ws-spin-primary")).toBe(
      "#ff0000",
    );
    picked.lifecycle.unmount();
  });

  it("draws no mark for a finished thread", async () => {
    const slot = await mount(
      [
        sidebarThread("finished", {
          title: "Finished",
          latestAttentionAt: 100,
        }),
      ],
      {
        settings: { showRecent: false },
        analysis: {
          finished: {
            recap: "Shipped it.",
            state: "done",
            needsYou: null,
            subject: null,
            drift: null,
            driftSectionId: null,
            revision: 100,
            at: Date.now(),
            model: "m",
          },
        },
      },
    );
    const row = within(slot.getByRole("region", { name: "Unsorted" }));
    expect(row.getByRole("link").getAttribute("aria-label")).toBe("Finished");
    expect(row.queryByText("✓")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("archives a thread from its hover button without opening it", async () => {
    let navigated = 0;
    const slot = await mount(undefined, {
      settings: { showRecent: false },
      onNavigate: () => navigated++,
    });
    const row = within(slot.getByRole("region", { name: "Beta" }))
      .getByRole("link", { name: "Beta task" })
      .closest("li")!;
    fireEvent.click(
      within(row).getByRole("button", { name: "Archive thread" }),
    );
    expect(slot.inspection.sidebarActionCalls.at(-1)).toMatchObject({
      method: "archive",
    });
    expect(navigated).toBe(0);
    slot.lifecycle.unmount();
  });

  it("shows workstreams and threads in the stored manual order", async () => {
    const slot = await mount(
      [
        sidebarThread("a1", { sectionId: "sec_a", title: "A one" }),
        sidebarThread("b1", { sectionId: "sec_b", title: "B one" }),
        sidebarThread("b2", { sectionId: "sec_b", title: "B two" }),
        sidebarThread("b3", { sectionId: "sec_b", title: "B three" }),
      ],
      {
        settings: { showRecent: false },
        order: { workstreams: ["sec_b"], threads: { sec_b: ["b3", "b1"] } },
      },
    );
    await waitFor(() =>
      expect(
        slot.getAllByRole("region").map((r) => r.getAttribute("aria-label")),
      ).toEqual(["Beta", "Alpha", "Dormant"]),
    );
    expect(groupRows(slot, "Beta")).toEqual(["B two", "B three", "B one"]);
    slot.lifecycle.unmount();
  });

  it("reorders roots by dragging a row", async () => {
    const restore = layoutByRows();
    try {
      const slot = await mount(
        [
          sidebarThread("l1", { title: "Loose one", latestAttentionAt: 3 }),
          sidebarThread("l2", { title: "Loose two", latestAttentionAt: 2 }),
          sidebarThread("l3", { title: "Loose three", latestAttentionAt: 1 }),
        ],
        { settings: { showRecent: false } },
      );
      expect(groupRows(slot, "Unsorted")).toEqual([
        "Loose one",
        "Loose two",
        "Loose three",
      ]);
      let navigated = 0;
      const link = slot.getByRole("link", { name: "Loose three" });
      link.addEventListener("click", (event) => {
        if (!event.defaultPrevented) navigated++;
      });
      const row = link.closest("li")!;
      fireEvent.mouseDown(row, {
        button: 0,
        clientX: 10,
        clientY: 2 * 28 + 14,
      });
      fireEvent.mouseMove(document, { clientX: 10, clientY: 2 * 28 + 4 });
      fireEvent.mouseMove(document, { clientX: 10, clientY: 10 });
      fireEvent.mouseUp(document, { clientX: 10, clientY: 10 });
      fireEvent.click(link);
      await waitFor(() =>
        expect(
          slot.inspection.rpcCalls.find((c) => c.method === "reorder")?.input,
        ).toEqual({
          kind: "threads",
          groupId: "unsorted",
          ids: ["l3", "l1", "l2"],
        }),
      );
      expect(groupRows(slot, "Unsorted")).toEqual([
        "Loose three",
        "Loose one",
        "Loose two",
      ]);
      expect(navigated).toBe(0);
      expect(
        slot.inspection.sidebarActionCalls.some((c) => c.method === "open"),
      ).toBe(false);
      slot.lifecycle.unmount();
    } finally {
      restore();
    }
  });
});

/**
 * jsdom has no layout. Lays rows out 28px apart in document order, 200px
 * wide, and gives every other element the union of the rows it contains.
 */
function layoutByRows(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const anchors = [...document.querySelectorAll("[data-sidebar-thread-id]")];
    const inside = anchors
      .map((a, i) => [a, i] as const)
      .filter(([a]) => this === a || this.contains(a));
    if (!inside.length) return new DOMRect(0, 0, 0, 0);
    const top = inside[0]![1] * 28;
    const bottom = (inside.at(-1)![1] + 1) * 28;
    return new DOMRect(0, top, 200, bottom - top);
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}
