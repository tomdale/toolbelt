// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
    settings?: Record<string, boolean | string>;
    spinner?: unknown;
    onNavigate?: () => void;
    analysis?: Record<string, unknown>;
    order?: { workstreams: string[]; threads: Record<string, string[]> };
    snoozes?: Record<
      string,
      { until: number | null; attentionAt: number; at: number }
    >;
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
          snoozes: options.snoozes ?? {},
        }),
        moveThread: () => ({ entry: null }),
        snooze: (raw: unknown) => ({
          snooze: {
            until: (raw as { until: number | null }).until,
            attentionAt: 0,
            at: Date.now(),
          },
        }),
        unsnooze: () => ({ woke: true }),
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

  it("shows For you and Recent as overlays without removing group rows", async () => {
    const slot = await mount([
      sidebarThread("ask", {
        sectionId: "sec_a",
        title: "Asking task",
        hasPendingInteraction: true,
        indicator: "waiting-for-input",
      }),
      sidebarThread("other", { sectionId: "sec_b", title: "Other task" }),
    ]);
    expect(groupRows(slot, "For you")).toEqual(["Asking task"]);
    expect(groupRows(slot, "Recent")).toEqual(["Other task"]);
    expect(groupRows(slot, "Alpha")).toEqual(["Asking task"]);
    expect(
      within(slot.getByRole("region", { name: "Alpha" })).getByTitle(
        "1 for you",
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

  it("folds the status slot away only when no row in the group has a mark", async () => {
    const slots = (slot: Awaited<ReturnType<typeof mount>>, name: string) =>
      [
        ...slot
          .getByRole("region", { name })
          .querySelectorAll(".ws-status-slot"),
      ].map((el) => el.hasAttribute("data-collapsed"));
    const quiet = await mount(
      [
        sidebarThread("a", { sectionId: "sec_a", title: "A" }),
        sidebarThread("b", { sectionId: "sec_a", title: "B" }),
      ],
      { settings: { showRecent: false } },
    );
    await quiet.findByRole("region", { name: "Alpha" });
    expect(slots(quiet, "Alpha")).toEqual([true, true]);
    quiet.lifecycle.unmount();
    const marked = await mount(
      [
        sidebarThread("a", { sectionId: "sec_a", title: "A", isUnread: true }),
        sidebarThread("b", { sectionId: "sec_a", title: "B" }),
      ],
      { settings: { showRecent: false } },
    );
    await marked.findByRole("region", { name: "Alpha" });
    expect(slots(marked, "Alpha")).toEqual([false, false]);
    marked.lifecycle.unmount();
  });

  it("caps For you at five threads with a way to show the rest", async () => {
    const at = Date.now();
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const slot = await mount(
      ids.map((id, index) =>
        sidebarThread(id, {
          title: `Ask ${id}`,
          latestAttentionAt: 100 + index,
        }),
      ),
      {
        analysis: Object.fromEntries(
          ids.map((id, index) => [
            id,
            {
              recap: "Asked.",
              state: "needs_decision",
              needsYou: "Decide?",
              subject: null,
              drift: null,
              driftSectionId: null,
              revision: 100 + index,
              at,
              model: "m",
            },
          ]),
        ),
      },
    );
    const band = await slot.findByRole("region", { name: "For you" });
    expect(within(band).getAllByRole("link")).toHaveLength(5);
    fireEvent.click(within(band).getByRole("button", { name: "Show 2 more" }));
    expect(within(band).getAllByRole("link")).toHaveLength(7);
    fireEvent.click(within(band).getByRole("button", { name: "Show less" }));
    expect(within(band).getAllByRole("link")).toHaveLength(5);
    slot.lifecycle.unmount();
  });

  it("lists a current needs-decision result in For you, but not a stale one", async () => {
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
    const band = await slot.findByRole("region", { name: "For you" });
    // The section implies the decision, so its rows leave the mark out.
    expect(
      within(band)
        .getAllByRole("link")
        .map((a) => a.getAttribute("aria-label")),
    ).toEqual(["Fresh ask"]);
    // Each row carries what it asks, under the title.
    expect(band.textContent).toContain("Ship it?");
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

  it("keeps For you open and names each row's workstream", async () => {
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
    const band = await slot.findByRole("region", { name: "For you" });
    expect(within(band).getByText("Alpha")).toBeTruthy();
    // The section is always open: its header is a heading, not a toggle.
    expect(within(band).getByRole("heading", { name: /For you/ })).toBeTruthy();
    expect(within(band).queryByRole("button", { name: /For you/ })).toBeNull();
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
    fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
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

describe("snoozing", () => {
  const later = () => Date.now() + 3_600_000;
  const threads = () => [
    sidebarThread("ask", {
      sectionId: "sec_a",
      title: "Asking task",
      hasPendingInteraction: true,
      indicator: "waiting-for-input",
    }),
    sidebarThread("nap", { sectionId: "sec_a", title: "Napping task" }),
    sidebarThread("other", { sectionId: "sec_b", title: "Other task" }),
  ];

  it("moves snoozed threads into a collapsed Snoozed fold", async () => {
    const slot = await mount(threads(), {
      snoozes: {
        ask: { until: later(), attentionAt: 0, at: 0 },
        nap: { until: null, attentionAt: Date.now() + 1, at: 0 },
      },
    });
    await waitFor(() =>
      expect(slot.getByRole("button", { name: /Snoozed/ })).toBeTruthy(),
    );
    expect(slot.queryByRole("region", { name: "For you" })).toBeNull();
    expect(groupRows(slot, "Recent")).toEqual(["Other task"]);
    expect(slot.queryByRole("region", { name: "Alpha" })).toBeNull();
    const fold = slot.getByRole("button", { name: /Snoozed/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    expect(groupRows(slot, "Snoozed")).toEqual(["Asking task", "Napping task"]);
    expect(
      within(slot.getByRole("region", { name: "Snoozed" })).getByText(
        "On update",
      ),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("snoozes with the default choice from the row's hover button", async () => {
    const slot = await mount(threads(), {
      settings: { showRecent: false, snoozeDefault: "3 hours" },
    });
    const alpha = await waitFor(() =>
      slot.getByRole("region", { name: "Alpha" }),
    );
    const before = Date.now();
    fireEvent.click(
      within(alpha).getAllByRole("button", {
        name: /^Snooze until \d/,
      })[0]!,
    );
    await waitFor(() =>
      expect(groupRows(slot, "Alpha")).toEqual(["Napping task"]),
    );
    const call = slot.inspection.rpcCalls.find((c) => c.method === "snooze")!;
    const input = call.input as { threadId: string; until: number };
    expect(input.threadId).toBe("ask");
    expect(input.until - before).toBeGreaterThanOrEqual(3 * 3_600_000);
    expect(input.until - before).toBeLessThan(3 * 3_600_000 + 5_000);
    slot.lifecycle.unmount();
  });

  it("wakes a thread from the Snoozed fold", async () => {
    const slot = await mount(threads(), {
      settings: { showRecent: false },
      snoozes: { nap: { until: later(), attentionAt: 0, at: 0 } },
    });
    fireEvent.click(
      await waitFor(() => slot.getByRole("button", { name: /Snoozed/ })),
    );
    fireEvent.click(
      within(slot.getByRole("region", { name: "Snoozed" })).getByRole(
        "button",
        { name: /^Wake now/ },
      ),
    );
    await waitFor(() =>
      expect(groupRows(slot, "Alpha")).toEqual(["Asking task", "Napping task"]),
    );
    expect(slot.inspection.rpcCalls.at(-1)).toMatchObject({
      method: "unsnooze",
      input: { threadId: "nap" },
    });
    slot.lifecycle.unmount();
  });
});

it("keeps a snoozed child moving with its parent", async () => {
  const slot = await mount(
    [
      sidebarThread("root", { sectionId: "sec_a", title: "Root task" }),
      sidebarThread("kid", { parentThreadId: "root", title: "Kid task" }),
    ],
    {
      settings: { showRecent: false },
      snoozes: { kid: { until: Date.now() + 60_000, attentionAt: 0, at: 0 } },
    },
  );
  fireEvent.click(
    await waitFor(() => slot.getByRole("button", { name: /Snoozed/ })),
  );
  expect(groupRows(slot, "Alpha")).toEqual(["Root task"]);
  fireEvent.contextMenu(
    within(slot.getByRole("region", { name: "Snoozed" })).getByRole("link", {
      name: "Kid task",
    }),
  );
  expect(await screen.findByText("Moves with its parent")).toBeTruthy();
  expect(screen.getByText("Wake now")).toBeTruthy();
  slot.lifecycle.unmount();
});

it("marks the row menu's submenus with a chevron", async () => {
  const slot = await mount(undefined, { settings: { showRecent: false } });
  fireEvent.contextMenu(
    within(slot.getByRole("region", { name: "Alpha" })).getByRole("link", {
      name: "Root task",
    }),
  );
  for (const name of ["Move to workstream", "Snooze"]) {
    const item = await screen.findByRole("menuitem", { name });
    expect(item.getAttribute("aria-haspopup")).toBe("menu");
    expect(item.querySelector('[data-icon="ChevronRight"]')).not.toBeNull();
  }
  expect(
    screen
      .getByRole("menuitem", { name: "Rename…" })
      .querySelector('[data-icon="ChevronRight"]'),
  ).toBeNull();
  slot.lifecycle.unmount();
});

describe("row hover buttons", () => {
  const rowOf = async (slot: Awaited<ReturnType<typeof mount>>) =>
    (
      await waitFor(() =>
        within(slot.getByRole("region", { name: "Alpha" })).getByRole("link", {
          name: "Root task",
        }),
      )
    ).parentElement!;

  it("opens every snooze choice from the chevron beside the snooze button", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const row = await rowOf(slot);
    const chevron = within(row).getByRole("button", {
      name: "More snooze options",
    });
    fireEvent.pointerDown(chevron, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    expect(chevron.getAttribute("data-state")).toBe("open");
    for (const label of ["1 hour", "Next week", "Pick a date and time…"])
      expect(menu.textContent).toContain(label);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^1 hour/ }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toMatchObject({
        method: "snooze",
        input: { threadId: "root" },
      }),
    );
    slot.lifecycle.unmount();
  });

  it("names the snooze, chevron, and archive buttons in tooltips", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const row = await rowOf(slot);
    for (const [name, tip] of [
      [/^Snooze until/, /^Snooze until/],
      ["More snooze options", "More snooze options"],
      ["Archive", "Archive"],
    ] as const) {
      const button = within(row).getByRole("button", { name });
      fireEvent.pointerMove(button, { pointerType: "mouse" });
      await waitFor(
        () =>
          expect(
            screen
              .queryAllByRole("tooltip")
              .some((tooltip) =>
                typeof tip === "string"
                  ? tooltip.textContent === tip
                  : tip.test(tooltip.textContent ?? ""),
              ),
          ).toBe(true),
        { timeout: 2000 },
      );
      fireEvent.pointerLeave(button, { pointerType: "mouse" });
    }
    slot.lifecycle.unmount();
  });
});
