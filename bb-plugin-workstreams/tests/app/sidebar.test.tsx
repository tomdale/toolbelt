// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  experimental_useSidebarThreads,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
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
    activeThreadId?: string | null;
    settings?: Record<string, boolean | string>;
    spinner?: unknown;
    onNavigate?: () => void;
    analysis?: Record<string, unknown>;
    recaps?: Record<string, unknown>;
    order?: {
      workstreams: string[];
      threads: Record<string, string[]>;
      prioritized?: string[];
    };
    snoozes?: Record<
      string,
      { until: number | null; attentionAt: number; at: number }
    >;
    snoozePrefs?: Record<string, unknown>;
    archived?: {
      status: "loading" | "ready" | "error";
      hasNextPage: boolean;
      isFetchingNextPage: boolean;
      isFetchNextPageError: boolean;
      fetchNextPage: () => Promise<void>;
    };
  } = {},
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  // Stateful like the server, so a refetch after a change never undoes it.
  const snoozes = { ...options.snoozes };
  const order = {
    prioritized: [] as string[],
    ...(options.order ?? { workstreams: [], threads: {} }),
  };
  const list = app.threadLists[0]!;
  const props = {
    activeThreadId:
      options.activeThreadId === undefined ? "beta" : options.activeThreadId,
    activeProjectId: null,
    isCompactViewport: false,
    onNavigate: options.onNavigate ?? (() => undefined),
    searchQuery: "",
  };
  const Component = list.component;
  function LiveThreadList(props: PluginThreadListProps) {
    // The SDK fixture has no live-thread setter. Publish a fresh snapshot on
    // rerender, matching the immutable updates delivered by the real hook.
    const snapshot = experimental_useSidebarThreads();
    snapshot.threads = [...threads];
    return <Component {...props} />;
  }
  const slot = renderSlot({ ...list, component: LiveThreadList }, props, {
    sidebarThreads: {
      status: "ready",
      threads,
      sections,
      projects: [],
      experimental_archived: options.archived ?? null,
    },
    settings: options.settings ?? {},
    sdk: { projects: { list: async () => [] } },
    rpc: {
      prefs: () => ({
        prefs: {
          sidebar: {
            showForYou: true,
            showRecent: options.settings?.showRecent !== false,
            showSnoozed: options.settings?.showSnoozed !== false,
            showArchived: options.settings?.showArchived !== false,
            recentLimit: 5,
            timestamps: options.settings?.timestamps ?? "show",
            threadCount: options.settings?.threadCount ?? "collapsed",
            waitingCount: options.settings?.waitingCount ?? "collapsed",
          },
          threads: {
            autoTitle: true,
            analysisModel: {
              kind: "gateway",
              model: "google/gemini-3.1-flash-lite",
            },
            showParentLink: false,
          },
          newWork: {
            homeProjectId: "",
            suggestions: true,
            suggestionsModel: {
              kind: "gateway",
              model: "google/gemini-3.1-flash-lite",
            },
          },
          organize: {
            model: { kind: "gateway", model: "openai/gpt-6-sol-fast" },
          },
          advanced: { hostId: "", debug: false },
        },
      }),
      state: () => ({
        ...emptyState(),
        analysis: options.analysis ?? {},
        recaps: options.recaps ?? {},
        order: {
          workstreams: [...order.workstreams],
          threads: { ...order.threads },
          prioritized: [...order.prioritized],
        },
        snoozes: { ...snoozes },
        snoozePrefs: options.snoozePrefs ?? {},
      }),
      moveThread: () => ({ entry: null }),
      snooze: (raw: unknown) => {
        const { threadId, until } = raw as {
          threadId: string;
          until: number | null;
        };
        snoozes[threadId] = { until, attentionAt: 0, at: Date.now() };
        return { snooze: snoozes[threadId] };
      },
      unsnooze: (raw: unknown) => {
        const { threadId } = raw as { threadId: string };
        const woke = threadId in snoozes;
        delete snoozes[threadId];
        return { woke };
      },
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
        if (input.kind === "workstreams") order.workstreams = input.ids;
        else if (input.kind === "prioritized") order.prioritized = input.ids;
        else order.threads[input.groupId!] = input.ids;
        return {
          order: {
            workstreams: [...order.workstreams],
            threads: { ...order.threads },
            prioritized: [...order.prioritized],
          },
        };
      },
    },
  });
  return {
    ...slot,
    selectThread: (activeThreadId: string | null) =>
      slot.rerender(
        <LiveThreadList {...props} activeThreadId={activeThreadId} />,
      ),
  };
}

const groupRows = (slot: Awaited<ReturnType<typeof mount>>, name: string) =>
  within(slot.getByRole("region", { name }))
    .getAllByRole("link")
    .map((a) => a.getAttribute("aria-label"));

describe("thread list", () => {
  it.each(["show", "hover", "hide"])(
    "applies the %s timestamp preference without hiding band context",
    async (timestamps) => {
      const slot = await mount(undefined, { settings: { timestamps } });
      const alpha = slot.getByRole("region", { name: "Alpha" });
      await waitFor(() => {
        const ages = alpha.querySelectorAll("[data-timestamp]");
        expect(ages).toHaveLength(timestamps === "hide" ? 0 : 2);
        for (const age of ages)
          expect(age.getAttribute("data-timestamp")).toBe(timestamps);
      });
      expect(
        within(slot.getByRole("region", { name: "Recent" })).getByText("Alpha"),
      ).toBeTruthy();
      slot.lifecycle.unmount();
    },
  );

  it.each([
    ["always", [true, true]],
    ["collapsed", [false, true]],
    ["never", [false, false]],
  ] as const)("shows header counts %s", async (when, [expanded, collapsed]) => {
    const slot = await mount(
      [
        sidebarThread("ask", {
          sectionId: "sec_a",
          title: "Asking task",
          hasPendingInteraction: true,
          indicator: "waiting-for-input",
        }),
      ],
      { settings: { threadCount: when, waitingCount: when } },
    );
    const alpha = within(slot.getByRole("region", { name: "Alpha" }));
    const counts = () => [
      alpha.queryByTitle("1 waiting on you") !== null,
      alpha.queryAllByText("1", { selector: "span" }).length,
    ];
    await waitFor(() => expect(counts()).toEqual([expanded, expanded ? 2 : 0]));
    fireEvent.click(alpha.getByRole("button", { name: "Alpha" }));
    expect(counts()).toEqual([collapsed, collapsed ? 2 : 0]);
    slot.lifecycle.unmount();
  });

  it("does not request or render archived threads when their fold is hidden", async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    const slot = await mount(
      [
        sidebarThread("archived", {
          title: "Archived task",
          isArchived: true,
          archivedAt: 100,
        }),
        sidebarThread("active", { title: "Active task" }),
      ],
      {
        settings: { showArchived: false },
        archived: {
          status: "ready",
          hasNextPage: true,
          isFetchingNextPage: false,
          isFetchNextPageError: false,
          fetchNextPage,
        },
      },
    );
    await waitFor(() =>
      expect(slot.queryByRole("button", { name: /^Archived\d*$/ })).toBeNull(),
    );
    expect(slot.queryByText("Archived task")).toBeNull();
    expect(fetchNextPage).not.toHaveBeenCalled();
    slot.lifecycle.unmount();
  });

  it("shows archived threads grouped by workstream and loads another page", async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    const slot = await mount(
      [
        sidebarThread("arch-alpha", {
          sectionId: "sec_a",
          title: "Archived Alpha task",
          isArchived: true,
          archivedAt: 300,
        }),
        sidebarThread("arch-alpha-old", {
          sectionId: "sec_a",
          title: "Older Alpha task",
          isArchived: true,
          archivedAt: 100,
        }),
        sidebarThread("arch-beta", {
          sectionId: "sec_b",
          title: "Archived Beta task",
          isArchived: true,
          archivedAt: 200,
        }),
        sidebarThread("arch-beta-child", {
          parentThreadId: "arch-alpha",
          sectionId: "sec_b",
          title: "Archived child task",
          isArchived: true,
          archivedAt: 250,
        }),
        sidebarThread("arch-loose", {
          title: "Archived loose task",
          isArchived: true,
          archivedAt: 50,
        }),
        sidebarThread("arch-hidden", {
          sectionId: "sec_a",
          title: "Hidden archived task",
          isArchived: true,
          isHidden: true,
          archivedAt: 400,
        }),
        sidebarThread("active", { sectionId: "sec_a", title: "Active task" }),
      ],
      {
        settings: { showRecent: false, showArchived: true },
        archived: {
          status: "ready",
          hasNextPage: true,
          isFetchingNextPage: false,
          isFetchNextPageError: false,
          fetchNextPage,
        },
      },
    );
    const archived = slot.getByRole("button", { name: /^Archived\d*$/ });
    expect(archived.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(archived);
    const alpha = within(slot.getByRole("region", { name: "Archived Alpha" }));
    fireEvent.click(alpha.getByRole("button", { name: /Alpha/ }));
    expect(
      alpha.getAllByRole("link").map((link) => link.getAttribute("aria-label")),
    ).toEqual([
      "Archived Alpha task",
      "Archived child task",
      "Older Alpha task",
    ]);
    const beta = within(slot.getByRole("region", { name: "Archived Beta" }));
    fireEvent.click(beta.getByRole("button", { name: /Beta/ }));
    expect(groupRows(slot, "Archived Beta")).toEqual(["Archived Beta task"]);
    const unsorted = within(
      slot.getByRole("region", { name: "Archived Unfiled" }),
    );
    fireEvent.click(unsorted.getByRole("button", { name: /Unfiled/ }));
    expect(groupRows(slot, "Archived Unfiled")).toEqual([
      "Archived loose task",
    ]);
    const archivedRegion = slot.getByRole("region", { name: "Archived" });
    expect(
      archivedRegion.querySelector('[data-sidebar-thread-id="active"]'),
    ).toBeNull();
    expect(
      archivedRegion.querySelector('[data-sidebar-thread-id="arch-hidden"]'),
    ).toBeNull();
    fireEvent.click(
      slot.getByRole("button", { name: "Load more archived threads" }),
    );
    expect(fetchNextPage).toHaveBeenCalledOnce();
    slot.lifecycle.unmount();
  });

  it("groups whole trees by the root's workstream and hides hidden threads", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    expect(groupRows(slot, "Alpha")).toEqual(["Root task", "Kid task"]);
    expect(groupRows(slot, "Beta")).toEqual(["Beta task"]);
    expect(groupRows(slot, "Unfiled")).toEqual(["Loose task"]);
    expect(slot.queryByText("Hidden helper")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows Unfiled, then empty workstreams, after populated ones; empty ones get a scoped New work action and no zero count", async () => {
    const slot = await mount(undefined, {
      settings: { showRecent: false },
      order: { workstreams: ["sec_z", "sec_b", "sec_a"], threads: {} },
    });
    await waitFor(() =>
      expect(
        slot.getAllByRole("region").map((r) => r.getAttribute("aria-label")),
      ).toEqual(["Beta", "Alpha", "Unfiled", "Zeta"]),
    );
    expect(slot.queryByRole("button", { name: /Dormant/ })).toBeNull();
    const empty = within(slot.getByRole("region", { name: "Zeta" }));
    expect(empty.queryByText("0")).toBeNull();
    const header = empty.getByRole("button", { name: "Zeta" });
    expect(header.hasAttribute("aria-expanded")).toBe(false);
    expect(header.querySelector('[data-icon^="Chevron"]')).toBeNull();
    fireEvent.click(header);
    expect(header.hasAttribute("aria-expanded")).toBe(false);
    expect(
      within(slot.getByRole("region", { name: "Beta" }))
        .getByRole("button", { name: "Beta" })
        .querySelector('[data-icon="ChevronDown"]'),
    ).not.toBeNull();
    expect(
      within(slot.getByRole("region", { name: "Beta" })).queryByText("1"),
    ).toBeNull();
    const newWork = empty.getByRole("button", { name: "New work in Zeta" });
    expect(newWork.classList.contains("opacity-0")).toBe(false);
    fireEvent.click(newWork);
    const dialog = within(
      await screen.findByRole("dialog", { name: "New work" }),
    );
    expect(dialog.getByRole("button", { name: /Zeta/ })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("leaves Unfiled out when every thread is in a workstream", async () => {
    const slot = await mount(
      [sidebarThread("a1", { sectionId: "sec_a", title: "Alpha task" })],
      { settings: { showRecent: false } },
    );
    await waitFor(() =>
      expect(
        slot.getAllByRole("region").map((r) => r.getAttribute("aria-label")),
      ).toEqual(["Alpha", "Beta", "Zeta"]),
    );
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

  it("sorts and groups Recent from its section menu and persists the preference", async () => {
    const slot = await mount([
      sidebarThread("a", {
        sectionId: "sec_a",
        title: "Zulu task",
        latestAttentionAt: 300,
      }),
      sidebarThread("b", {
        sectionId: "sec_b",
        title: "Alpha task",
        latestAttentionAt: 200,
      }),
    ]);
    const menuButton = slot.getByRole("button", { name: "Section options" });
    fireEvent.pointerDown(menuButton, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    fireEvent.click(
      within(menu).getByRole("menuitemradio", { name: "Title A–Z" }),
    );
    expect(groupRows(slot, "Recent")).toEqual(["Alpha task", "Zulu task"]);
    fireEvent.pointerDown(
      slot.getByRole("button", { name: "Section options" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitemcheckbox", {
        name: "Group by workstream",
      }),
    );
    expect(groupRows(slot, "Recent · Alpha")).toEqual(["Zulu task"]);
    expect(groupRows(slot, "Recent · Beta")).toEqual(["Alpha task"]);
    expect(
      JSON.parse(window.localStorage.getItem("workstreams:v1:band-options")!)
        .recent,
    ).toEqual({
      sort: "title",
      grouped: true,
    });
    slot.lifecycle.unmount();
  });

  it("shows Up Next and Recent as overlays without removing group rows", async () => {
    const slot = await mount([
      sidebarThread("ask", {
        sectionId: "sec_a",
        title: "Asking task",
        hasPendingInteraction: true,
        indicator: "waiting-for-input",
      }),
      sidebarThread("other", { sectionId: "sec_b", title: "Other task" }),
    ]);
    expect(groupRows(slot, "Up Next")).toEqual(["Asking task"]);
    expect(groupRows(slot, "Recent")).toEqual(["Other task"]);
    expect(groupRows(slot, "Alpha")).toEqual(["Asking task"]);
    const alpha = within(slot.getByRole("region", { name: "Alpha" }));
    expect(alpha.queryByTitle("1 waiting on you")).toBeNull();
    expect(alpha.queryByText("1", { selector: "span" })).toBeNull();
    fireEvent.click(alpha.getByRole("button", { name: "Alpha" }));
    expect(alpha.getByTitle("1 waiting on you")).toBeTruthy();
    expect(alpha.getAllByText("1", { selector: "span" })).toHaveLength(2);
    fireEvent.click(alpha.getByRole("button", { name: "Alpha" }));
    expect(alpha.queryByTitle("1 waiting on you")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("marks every workstream the sidebar names with the workstream icon", async () => {
    const slot = await mount([
      sidebarThread("ask", {
        sectionId: "sec_a",
        title: "Asking task",
        hasPendingInteraction: true,
        indicator: "waiting-for-input",
      }),
      sidebarThread("other", { sectionId: "sec_b", title: "Other task" }),
    ]);
    const icon = '[data-icon="workstreams/workstream"]';
    const heading = (name: string) =>
      slot.getByRole("region", { name }).querySelector("button");
    expect(heading("Alpha")?.querySelector(icon)).toBeTruthy();
    expect(heading("Beta")?.querySelector(icon)).toBeTruthy();
    // Overlay rows name their workstream where an age would sit.
    const upNext = slot.getByRole("region", { name: "Up Next" });
    expect(upNext.querySelector(icon)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("collapses a parent's children in its group", async () => {
    const slot = await mount();
    expect(groupRows(slot, "Alpha")).toEqual(["Root task", "Kid task"]);
    const alpha = within(slot.getByRole("region", { name: "Alpha" }));
    fireEvent.click(alpha.getByRole("button", { name: "Hide child threads" }));
    expect(groupRows(slot, "Alpha")).toEqual(["Root task"]);
    fireEvent.click(alpha.getByRole("button", { name: "Show child threads" }));
    expect(groupRows(slot, "Alpha")).toEqual(["Root task", "Kid task"]);
    slot.lifecycle.unmount();
  });

  it("shows only top-level threads in Recent", async () => {
    const slot = await mount();
    expect(groupRows(slot, "Recent").sort()).toEqual([
      "Beta task",
      "Loose task",
      "Root task",
    ]);
    expect(
      within(slot.getByRole("region", { name: "Recent" })).queryByRole(
        "button",
        { name: /child threads/i },
      ),
    ).toBeNull();
    expect(groupRows(slot, "Alpha")).toEqual(["Root task", "Kid task"]);
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
      slot.getByRole("region", { name: "Unfiled" }),
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

  it("caps Up Next at five threads with a way to show the rest", async () => {
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
    const band = await slot.findByRole("region", { name: "Up Next" });
    expect(within(band).getAllByRole("link")).toHaveLength(5);
    fireEvent.click(within(band).getByRole("button", { name: "Show 2 more" }));
    expect(within(band).getAllByRole("link")).toHaveLength(7);
    fireEvent.click(within(band).getByRole("button", { name: "Show less" }));
    expect(within(band).getAllByRole("link")).toHaveLength(5);
    slot.lifecycle.unmount();
  });

  it("lists a current needs-decision result in Up Next, but not a stale one", async () => {
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
    const band = await slot.findByRole("region", { name: "Up Next" });
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
      within(slot.getByRole("region", { name: "Unfiled" })).getAllByRole(
        "img",
        { name: "Needs your decision" },
      ),
    ).toHaveLength(1);
    slot.lifecycle.unmount();
  });

  it("includes unread reported results and open questions in Up Next", async () => {
    const at = Date.now();
    const recap = (state: string) => ({
      id: `r-${state}`,
      turnId: "turn",
      at,
      state,
      goal: "Shipping",
      latest: [`Reported ${state}`],
      review: state === "review" ? ["Try it"] : [],
      links: [],
    });
    const slot = await mount(
      [
        sidebarThread("complete", {
          title: "Complete",
          isUnread: true,
          latestAttentionAt: 100,
        }),
        sidebarThread("review", {
          title: "Review",
          isUnread: true,
          latestAttentionAt: 101,
        }),
        sidebarThread("question", {
          title: "Question",
          hasPendingInteraction: true,
          isUnread: false,
          latestAttentionAt: 102,
        }),
      ],
      { recaps: { complete: recap("complete"), review: recap("review") } },
    );
    const band = await slot.findByRole("region", { name: "Up Next" });
    expect(
      within(band)
        .getAllByRole("link")
        .map((a) => a.getAttribute("aria-label")),
    ).toEqual([
      "Question",
      "Review, Ready for your review",
      "Complete, Complete",
    ]);
    slot.lifecycle.unmount();
  });

  it("puts read threads with current recaps after higher-priority Up Next threads", async () => {
    const at = Date.now();
    const recap = (state: string) => ({
      id: `r-${state}`,
      turnId: "turn",
      at,
      state,
      goal: "Shipping",
      latest: [`Reported ${state}`],
      review: state === "review" ? ["Try it"] : [],
      links: [],
    });
    const slot = await mount(
      [
        sidebarThread("ask", {
          title: "Unread ask",
          isUnread: true,
          latestAttentionAt: 300,
        }),
        sidebarThread("complete", {
          title: "Read complete",
          latestAttentionAt: 200,
        }),
        sidebarThread("waiting", {
          title: "Read waiting",
          latestAttentionAt: 100,
        }),
        sidebarThread("without-recap", {
          title: "Read without recap",
          latestAttentionAt: 50,
        }),
      ],
      {
        analysis: {
          ask: {
            recap: "Asked.",
            state: "needs_decision",
            needsYou: "Decide?",
            subject: null,
            drift: null,
            driftSectionId: null,
            revision: 300,
            at,
            model: "m",
          },
        },
        recaps: {
          complete: recap("complete"),
          waiting: recap("waiting"),
        },
      },
    );
    const band = await slot.findByRole("region", { name: "Up Next" });
    expect(
      within(band)
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual([
      "Unread ask",
      "Read complete, Complete",
      "Read waiting, Waiting",
    ]);
    slot.lifecycle.unmount();
  });

  it.each([
    { nextThreadId: "other", readOnSelect: false },
    { nextThreadId: null, readOnSelect: false },
    { nextThreadId: "other", readOnSelect: true },
  ])(
    "keeps a read result until $nextThreadId is selected (readOnSelect: $readOnSelect)",
    async ({ nextThreadId, readOnSelect }) => {
      const threads = [
        sidebarThread("result", {
          title: "Result",
          isUnread: true,
          latestAttentionAt: 100,
        }),
        sidebarThread("other", { title: "Other", latestAttentionAt: 50 }),
      ];
      const slot = await mount(threads, {
        activeThreadId: "other",
        recaps: {
          result: {
            id: "result-recap",
            turnId: "turn",
            at: 100,
            state: "complete",
            goal: "Shipping",
            latest: ["Finished"],
            review: [],
            links: [],
          },
        },
      });
      await slot.findByRole("region", { name: "Up Next" });
      if (!readOnSelect) slot.selectThread("result");
      threads[0] = {
        ...threads[0]!,
        isUnread: false,
        displayTitle: "Updated result",
      };
      slot.selectThread("result");
      await waitFor(() => {
        expect(groupRows(slot, "Up Next")).toEqual([
          "Updated result, Complete",
        ]);
      });
      expect(groupRows(slot, "Recent")).toEqual(["Other"]);

      slot.selectThread(nextThreadId);
      expect(groupRows(slot, "Up Next")).toContain("Updated result, Complete");
      expect(groupRows(slot, "Recent")).not.toContain(
        "Updated result, Complete",
      );
      slot.selectThread("result");
      expect(groupRows(slot, "Up Next")).toContain("Updated result, Complete");
      slot.lifecycle.unmount();
    },
  );

  it("releases a resolved question only after selecting another thread", async () => {
    const threads = [
      sidebarThread("question", {
        title: "Question",
        hasPendingInteraction: true,
      }),
      sidebarThread("other", { title: "Other" }),
    ];
    const slot = await mount(threads, { activeThreadId: "question" });
    await slot.findByRole("region", { name: "Up Next" });
    threads[0] = {
      ...threads[0]!,
      hasPendingInteraction: false,
      status: "active",
    };
    slot.selectThread("question");
    await waitFor(() =>
      expect(groupRows(slot, "Up Next")).toEqual(["Question"]),
    );
    slot.selectThread("other");
    expect(slot.queryByRole("region", { name: "Up Next" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it.each(["hidden", "archived", "snoozed"])(
    "still removes a selected Up Next thread when explicitly %s",
    async (action) => {
      const threads = [
        sidebarThread("question", {
          title: "Question",
          hasPendingInteraction: true,
          latestAttentionAt: 100,
        }),
      ];
      const slot = await mount(threads, { activeThreadId: "question" });
      const band = await slot.findByRole("region", { name: "Up Next" });
      if (action === "snoozed") {
        fireEvent.click(
          within(band).getByRole("button", { name: /^Snooze until/ }),
        );
      } else {
        threads[0] = {
          ...threads[0]!,
          isHidden: action === "hidden",
          isArchived: action === "archived",
        };
        slot.selectThread("question");
      }
      await waitFor(() =>
        expect(slot.queryByRole("region", { name: "Up Next" })).toBeNull(),
      );
      slot.lifecycle.unmount();
    },
  );

  it("marks the agent's reported state, which outranks analysis", async () => {
    const at = Date.now();
    const recap = (state: string) => ({
      id: `r-${state}`,
      turnId: "turn",
      at,
      state,
      goal: "Shipping",
      latest: [`Reported ${state}`],
      review: state === "review" ? ["Try it"] : [],
      links: [],
    });
    const slot = await mount(
      [
        sidebarThread("asked", { title: "Asked", latestAttentionAt: 100 }),
        sidebarThread("finished", {
          title: "Finished",
          latestAttentionAt: 100,
        }),
      ],
      {
        // Analysis read the turn as a question; the agent reported it done.
        analysis: {
          asked: {
            recap: "Asked whether to ship.",
            state: "needs_decision",
            needsYou: "Ship it?",
            subject: null,
            drift: null,
            driftSectionId: null,
            revision: 100,
            at,
            model: "m",
          },
        },
        recaps: { asked: recap("review"), finished: recap("complete") },
      },
    );
    const group = await slot.findByRole("region", { name: "Unfiled" });
    const band = await slot.findByRole("region", { name: "Up Next" });
    expect(
      within(band).getByRole("link", { name: "Asked, Ready for your review" }),
    ).toBeTruthy();
    expect(
      within(band).getByRole("link", { name: "Finished, Complete" }),
    ).toBeTruthy();
    expect(
      within(group).getByRole("img", { name: "Ready for your review" }),
    ).toBeTruthy();
    expect(within(group).getByRole("img", { name: "Complete" })).toBeTruthy();
    expect(
      within(group).getByRole("link", { name: "Finished, Complete" }).title,
    ).toContain("Reported complete");
    slot.lifecycle.unmount();
  });

  it("keeps Up Next open and names each row's workstream", async () => {
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
    const band = await slot.findByRole("region", { name: "Up Next" });
    expect(within(band).getByText("Alpha")).toBeTruthy();
    // The section is always open: its header is a heading, not a toggle.
    expect(within(band).getByRole("heading", { name: /Up Next/ })).toBeTruthy();
    expect(within(band).queryByRole("button", { name: /Up Next/ })).toBeNull();
    expect(within(band).queryByText(/via/)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("draws the working indicator chosen in settings, and follows changes", async () => {
    const working = [
      sidebarThread("busy", { title: "Busy", indicator: "runtime" }),
    ];
    const markOf = (slot: Awaited<ReturnType<typeof mount>>) =>
      within(slot.getByRole("region", { name: "Unfiled" })).getByRole("img", {
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
    const row = within(slot.getByRole("region", { name: "Unfiled" }));
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
      ).toEqual(["Beta", "Alpha", "Zeta"]),
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
      expect(groupRows(slot, "Unfiled")).toEqual([
        "Loose one",
        "Loose two",
        "Loose three",
      ]);
      await waitFor(() =>
        expect(slot.queryByRole("region", { name: "Recent" })).toBeNull(),
      );
      let navigated = 0;
      const link = slot.container.querySelector<HTMLAnchorElement>(
        '[data-sidebar-thread-id="l3"]',
      )!;
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
      expect(groupRows(slot, "Unfiled")).toEqual([
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
    const slot = await mount(
      [
        ...threads(),
        sidebarThread("nap-child", {
          parentThreadId: "nap",
          sectionId: "sec_a",
          title: "Nap child task",
        }),
      ],
      {
        snoozes: {
          ask: { until: later(), attentionAt: 0, at: 0 },
          nap: { until: null, attentionAt: Date.now() + 1, at: 0 },
        },
      },
    );
    await waitFor(() =>
      expect(slot.getByRole("button", { name: /^Snoozed\d*$/ })).toBeTruthy(),
    );
    expect(slot.queryByRole("region", { name: "Up Next" })).toBeNull();
    expect(groupRows(slot, "Recent")).toEqual(["Other task"]);
    expect(
      within(slot.getByRole("region", { name: "Alpha" })).queryAllByRole(
        "link",
      ),
    ).toEqual([]);
    const fold = slot.getByRole("button", { name: /^Snoozed\d*$/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    expect(groupRows(slot, "Snoozed")).toEqual([
      "Asking task",
      "Napping task",
      "Nap child task",
    ]);
    const napRow = within(slot.getByRole("region", { name: "Snoozed" }))
      .getByRole("link", { name: "Napping task" })
      .closest("li")!;
    fireEvent.click(
      within(napRow).getByRole("button", { name: "Hide child threads" }),
    );
    expect(groupRows(slot, "Snoozed")).toEqual(["Asking task", "Napping task"]);
    fireEvent.click(
      within(napRow).getByRole("button", { name: "Show child threads" }),
    );
    expect(groupRows(slot, "Snoozed")).toEqual([
      "Asking task",
      "Napping task",
      "Nap child task",
    ]);
    expect(
      within(slot.getByRole("region", { name: "Snoozed" })).getByText(
        "On update",
      ),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("hides snoozed threads without resurfacing them in other groups", async () => {
    const slot = await mount(threads(), {
      settings: { showSnoozed: false },
      snoozes: { nap: { until: later(), attentionAt: 0, at: 0 } },
    });
    await waitFor(() =>
      expect(groupRows(slot, "Alpha")).toEqual(["Asking task"]),
    );
    expect(slot.queryByRole("button", { name: /^Snoozed\d*$/ })).toBeNull();
    expect(slot.queryAllByRole("link", { name: "Napping task" })).toHaveLength(
      0,
    );
    expect(groupRows(slot, "Recent")).toEqual(["Other task"]);
    expect(groupRows(slot, "Alpha")).toEqual(["Asking task"]);
    slot.lifecycle.unmount();
  });

  it("snoozes with the default choice from the row's hover button", async () => {
    const slot = await mount(threads(), {
      settings: { showRecent: false },
      snoozePrefs: { default: "3h" },
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
      await waitFor(() => slot.getByRole("button", { name: /^Snoozed\d*$/ })),
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
    expect(
      slot.inspection.rpcCalls.some(
        (call) =>
          call.method === "unsnooze" &&
          (call.input as { threadId?: string }).threadId === "nap",
      ),
    ).toBe(true);
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
    await waitFor(() => slot.getByRole("button", { name: /^Snoozed\d*$/ })),
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

  const snoozeButton = (row: HTMLElement) =>
    within(row).getByRole("button", { name: /^Snooze until/ });

  it("opens the quick choices when the pointer rests on the snooze button", async () => {
    const slot = await mount(undefined, {
      settings: { showRecent: false },
      snoozePrefs: { quick: ["30m", "weekend"] },
    });
    const button = snoozeButton(await rowOf(slot));
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    const menu = await screen.findByRole("menu", {}, { timeout: 2000 });
    expect(button.getAttribute("data-state")).toBe("open");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringMatching(/^30 minutes/),
      expect.stringMatching(/^This weekend/),
      "Pick a date and time…",
    ]);
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: /^30 minutes/ }),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const call = slot.inspection.rpcCalls.find((c) => c.method === "snooze")!;
    expect(call.input).toMatchObject({ threadId: "root" });
    slot.lifecycle.unmount();
  });

  it("does nothing when the pointer only passes over the button", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const button = snoozeButton(await rowOf(slot));
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByRole("menu")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("stays open on the way into the menu and closes after leaving it", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const button = snoozeButton(await rowOf(slot));
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    const menu = await screen.findByRole("menu", {}, { timeout: 2000 });
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    fireEvent.pointerEnter(menu, { pointerType: "mouse" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByRole("menu")).not.toBeNull();
    fireEvent.pointerLeave(menu, { pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    slot.lifecycle.unmount();
  });

  it("leaves focus where it was when the menu opens on hover", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();
    const button = snoozeButton(await rowOf(slot));
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    await screen.findByRole("menu", {}, { timeout: 2000 });
    expect(document.activeElement).toBe(composer);
    composer.remove();
    slot.lifecycle.unmount();
  });

  it("snoozes on click, and opens the menu from the keyboard with ArrowDown", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const button = snoozeButton(await rowOf(slot));
    button.focus();
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    const [first, second] = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((c) => c.method === "snooze")).toBe(
        true,
      ),
    );
    slot.lifecycle.unmount();
  });

  it("puts archive and snooze left of the age", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const row = await rowOf(slot);
    expect(
      within(row)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label"))
        .filter((label) => label === "Archive" || /^Snooze/.test(label ?? "")),
    ).toEqual(["Archive", expect.stringMatching(/^Snooze until/)]);
    // The age is the row's last element and stays out of the hover group.
    const age = row.lastElementChild!;
    expect(age.textContent).toBe("now");
    expect(
      age.contains(within(row).getByRole("button", { name: "Archive" })),
    ).toBe(false);
    slot.lifecycle.unmount();
  });

  it("names the archive button in a tooltip", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const row = await rowOf(slot);
    fireEvent.pointerMove(
      within(row).getByRole("button", { name: "Archive" }),
      {
        pointerType: "mouse",
      },
    );
    const tooltip = await screen.findByRole("tooltip", {}, { timeout: 2000 });
    expect(tooltip.textContent).toBe("Archive");
    slot.lifecycle.unmount();
  });
});

describe("prioritized workstreams", () => {
  const regions = (slot: Awaited<ReturnType<typeof mount>>) =>
    slot.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
  const asking = (id: string, sectionId: string, at: number) =>
    sidebarThread(id, {
      sectionId,
      title: `Ask ${id}`,
      hasPendingInteraction: true,
      latestAttentionAt: at,
    });

  it("prioritizes from the header menu and pins the workstream below Up Next", async () => {
    const slot = await mount(
      [
        asking("a1", "sec_a", 100),
        sidebarThread("z1", { sectionId: "sec_z", title: "Zeta task" }),
      ],
      { activeThreadId: null },
    );
    await waitFor(() =>
      expect(regions(slot)).toEqual([
        "Up Next",
        "Recent",
        "Alpha",
        "Zeta",
        "Beta",
      ]),
    );
    const zeta = slot.getByRole("region", { name: "Zeta" });
    fireEvent.contextMenu(within(zeta).getByRole("button", { name: "Zeta" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Prioritize" }));
    // The rest hide behind the lower-priority toggle.
    await waitFor(() =>
      expect(regions(slot)).toEqual(["Up Next", "Zeta", "Recent"]),
    );
    expect(
      within(slot.getByRole("region", { name: "Zeta" }))
        .getByRole("button", { name: "Remove priority from Zeta" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "reorder")?.input,
    ).toEqual({ kind: "prioritized", ids: ["sec_z"] });

    fireEvent.contextMenu(
      within(slot.getByRole("region", { name: "Zeta" })).getByRole("button", {
        name: "Zeta",
      }),
    );
    fireEvent.click(
      await slot.findByRole("menuitem", { name: "Remove priority" }),
    );
    await waitFor(() =>
      expect(regions(slot)).toEqual([
        "Up Next",
        "Recent",
        "Alpha",
        "Zeta",
        "Beta",
      ]),
    );
    slot.lifecycle.unmount();
  });

  it("prioritizes from the header's inline button", async () => {
    const slot = await mount(
      [
        sidebarThread("a1", { sectionId: "sec_a", title: "Alpha task" }),
        sidebarThread("b1", { sectionId: "sec_b", title: "Beta task" }),
      ],
      { activeThreadId: null, settings: { showRecent: false } },
    );
    await waitFor(() =>
      expect(regions(slot)).toEqual(["Alpha", "Beta", "Zeta"]),
    );
    fireEvent.click(slot.getByRole("button", { name: "Prioritize Beta" }));
    await waitFor(() => expect(regions(slot)).toEqual(["Beta"]));
    const off = slot.getByRole("button", { name: "Remove priority from Beta" });
    expect(off.getAttribute("aria-pressed")).toBe("true");
    // The click stays on the button: the group doesn't collapse.
    expect(groupRows(slot, "Beta")).toEqual(["Beta task"]);
    fireEvent.click(off);
    await waitFor(() =>
      expect(regions(slot)).toEqual(["Alpha", "Beta", "Zeta"]),
    );
    expect(
      slot.queryByRole("button", { name: "Prioritize Unfiled" }),
    ).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows only prioritized threads in Up Next while one is waiting", async () => {
    const slot = await mount(
      [
        asking("a1", "sec_a", 300),
        asking("b1", "sec_b", 200),
        asking("z1", "sec_z", 100),
        sidebarThread("recap", {
          title: "Read recap",
          latestAttentionAt: 50,
        }),
      ],
      {
        activeThreadId: null,
        order: { workstreams: [], threads: {}, prioritized: ["sec_z"] },
        recaps: {
          recap: {
            id: "read-recap",
            turnId: "turn",
            at: 50,
            state: "complete",
            goal: "Finished",
            latest: ["Ready"],
            review: [],
            links: [],
          },
        },
      },
    );
    await waitFor(() => expect(groupRows(slot, "Up Next")).toEqual(["Ask z1"]));
    const band = slot.getByRole("region", { name: "Up Next" });
    expect(within(band).queryAllByRole("button", { name: /more/ })).toEqual([]);
    // What Up Next leaves out is counted on the lower-priority toggle, and
    // waits in its workstream with a neutral count.
    fireEvent.click(
      slot.getByRole("button", {
        name: "Show lower priority workstreams, 2 waiting on you",
      }),
    );
    const alpha = within(slot.getByRole("region", { name: "Alpha" }));
    expect(
      alpha
        .getByRole("button", { name: "Alpha" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(alpha.getByTitle("1 waiting on you").className).not.toContain(
      "ws-amber-pill",
    );

    // With no prioritized thread waiting, Up Next shows everything.
    slot.lifecycle.unmount();
    const unfocused = await mount(
      [
        asking("a1", "sec_a", 300),
        asking("b1", "sec_b", 200),
        sidebarThread("recap", {
          title: "Read recap",
          latestAttentionAt: 50,
        }),
      ],
      {
        activeThreadId: null,
        order: { workstreams: [], threads: {}, prioritized: ["sec_z"] },
        recaps: {
          recap: {
            id: "read-recap",
            turnId: "turn",
            at: 50,
            state: "complete",
            goal: "Finished",
            latest: ["Ready"],
            review: [],
            links: [],
          },
        },
      },
    );
    await waitFor(() =>
      expect(groupRows(unfocused, "Up Next")).toEqual([
        "Ask a1",
        "Ask b1",
        "Read recap, Complete",
      ]),
    );
    expect(
      unfocused.getByRole("button", {
        name: "Show lower priority workstreams",
      }),
    ).toBeTruthy();
    unfocused.lifecycle.unmount();
  });

  it("hides lower-priority workstreams until revealed, then shows them collapsed", async () => {
    const slot = await mount(
      [
        sidebarThread("a1", { sectionId: "sec_a", title: "Alpha task" }),
        sidebarThread("z1", { sectionId: "sec_z", title: "Zeta task" }),
        sidebarThread("loose", { title: "Loose task" }),
      ],
      {
        activeThreadId: null,
        settings: { showRecent: false },
        order: { workstreams: [], threads: {}, prioritized: ["sec_z"] },
      },
    );
    await waitFor(() => expect(regions(slot)).toEqual(["Zeta"]));
    expect(groupRows(slot, "Zeta")).toEqual(["Zeta task"]);
    const show = slot.getByRole("button", {
      name: "Show lower priority workstreams",
    });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(show);
    expect(regions(slot)).toEqual(["Zeta", "Alpha", "Unfiled", "Beta"]);
    const alpha = slot.getByRole("region", { name: "Alpha" });
    expect(within(alpha).queryAllByRole("link")).toHaveLength(0);
    fireEvent.click(within(alpha).getByRole("button", { name: "Alpha" }));
    expect(groupRows(slot, "Alpha")).toEqual(["Alpha task"]);

    // Hiding and revealing again starts every one collapsed.
    fireEvent.click(
      slot.getByRole("button", { name: "Hide lower priority workstreams" }),
    );
    expect(regions(slot)).toEqual(["Zeta"]);
    fireEvent.click(
      slot.getByRole("button", { name: "Show lower priority workstreams" }),
    );
    expect(
      within(slot.getByRole("region", { name: "Alpha" })).queryAllByRole(
        "link",
      ),
    ).toHaveLength(0);

    // Without priorities, every workstream shows with its own collapse state.
    fireEvent.click(
      slot.getByRole("button", { name: "Remove priority from Zeta" }),
    );
    await waitFor(() =>
      expect(regions(slot)).toEqual(["Alpha", "Zeta", "Unfiled", "Beta"]),
    );
    expect(groupRows(slot, "Alpha")).toEqual(["Alpha task"]);
    expect(
      slot.queryByRole("button", { name: /lower priority workstreams/ }),
    ).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps the open thread's row when a prioritized thread arrives", async () => {
    const threads = [
      asking("a1", "sec_a", 100),
      sidebarThread("z1", { sectionId: "sec_z", title: "Zeta task" }),
    ];
    const slot = await mount(threads, {
      activeThreadId: "a1",
      order: { workstreams: [], threads: {}, prioritized: ["sec_z"] },
    });
    await waitFor(() => expect(groupRows(slot, "Up Next")).toEqual(["Ask a1"]));
    threads[1] = asking("z1", "sec_z", 200);
    slot.selectThread("a1");
    await waitFor(() =>
      expect(groupRows(slot, "Up Next")).toEqual(["Ask z1", "Ask a1"]),
    );
    // Moving on lets focus take it.
    slot.selectThread("z1");
    await waitFor(() => expect(groupRows(slot, "Up Next")).toEqual(["Ask z1"]));
    expect(
      slot.getByRole("button", {
        name: "Show lower priority workstreams, 1 waiting on you",
      }),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("closes a leaving row before removing it, hidden from assistive technology", async () => {
    // jsdom has no Web Animations; motion runs only where they exist.
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: () => ({}),
    });
    try {
      const threads = [
        asking("a1", "sec_a", 100),
        sidebarThread("z1", { sectionId: "sec_z", title: "Zeta task" }),
      ];
      const slot = await mount(threads, {
        activeThreadId: null,
        order: { workstreams: [], threads: {}, prioritized: ["sec_z"] },
      });
      await waitFor(() =>
        expect(groupRows(slot, "Up Next")).toEqual(["Ask a1"]),
      );
      threads[1] = asking("z1", "sec_z", 200);
      slot.selectThread(null);
      await waitFor(() =>
        expect(groupRows(slot, "Up Next")).toEqual(["Ask z1"]),
      );
      const band = slot.getByRole("region", { name: "Up Next" });
      const leaving = band.querySelector('[data-presence="leave"]');
      expect(leaving?.getAttribute("aria-hidden")).toBe("true");
      expect(leaving?.textContent).toContain("Ask a1");
      expect(
        band.querySelector('[data-presence="enter"]')?.textContent,
      ).toContain("Ask z1");
      await waitFor(() =>
        expect(band.querySelector("[data-presence]")).toBeNull(),
      );
      expect(band.textContent).not.toContain("Ask a1");
      slot.lifecycle.unmount();
    } finally {
      delete (Element.prototype as { animate?: unknown }).animate;
    }
  });
});
