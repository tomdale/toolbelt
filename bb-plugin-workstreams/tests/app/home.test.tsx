// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { HOME_STATE_KEY } from "../../src/app/home/useHomeState.ts";
import {
  decisionFor,
  mountHome,
  recapOf,
  section,
  sidebarThread,
} from "./home-mount.tsx";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

type Slot = Awaited<ReturnType<typeof mountHome>>;

const minutes = (count: number) => Date.now() - count * 60_000 - 5_000;
/** A recent, fixed time: analysis is current only for the revision it saw. */
const RECENT = Date.now() - 60_000;
const region = (slot: Slot, name: string) => slot.getByRole("region", { name });
/** The title each row in `element` shows, in order. */
const links = (element: HTMLElement) =>
  within(element)
    .queryAllByRole("link")
    .map((link) => link.querySelector(".ws-home-title")?.textContent ?? null);
const regionNames = (slot: Slot) =>
  [...slot.container.querySelectorAll("section[aria-label]")].map((element) =>
    element.getAttribute("aria-label"),
  );
const open = (slot: Slot, name: string | RegExp) =>
  fireEvent.click(slot.getByRole("button", { name }));

/** Two workstreams, a loose thread, and one thread waiting on the user. */
const sample = () => [
  sidebarThread("ask", {
    sectionId: "sec_a",
    title: "Asking task",
    hasPendingInteraction: true,
    indicator: "waiting-for-input",
    latestAttentionAt: minutes(3),
  }),
  sidebarThread("a1", {
    sectionId: "sec_a",
    title: "Alpha one",
    latestAttentionAt: minutes(30),
  }),
  sidebarThread("b1", {
    sectionId: "sec_b",
    title: "Beta one",
    latestAttentionAt: minutes(60),
  }),
  sidebarThread("loose", {
    title: "Loose task",
    latestAttentionAt: minutes(90),
  }),
];

describe("Home screen", () => {
  it("takes BB's place inside its compact home", async () => {
    const slot = await mountHome({ threads: sample() });
    await slot.findByRole("region", { name: "Up Next" });
    const root = slot.container.querySelector("[data-ws-home]");
    expect(root?.getAttribute("data-ws-home")).toBe("takeover");
    expect(regionNames(slot)).toEqual([
      "Up Next",
      "Workstreams",
      "Alpha",
      "Beta",
      "Unfiled",
    ]);
  });

  describe("Up Next", () => {
    it("lists what needs the user with its workstream, what it asks, and its age", async () => {
      const slot = await mountHome({
        threads: sample(),
        analysis: { a1: decisionFor(0, "Ship it?") },
      });
      // The analysis is stale for any thread whose revision differs.
      const band = await slot.findByRole("region", { name: "Up Next" });
      expect(links(band)).toEqual(["Asking task"]);
      const row = within(band).getByRole("link");
      expect(row.getAttribute("href")).toBe("/projects/proj_1/threads/ask");
      expect(row.textContent).toContain("Alpha");
      expect(row.textContent).toContain("3m");
      expect(
        row
          .querySelector<HTMLElement>(".ws-home-ws")
          ?.style.getPropertyValue("--ws-hue"),
      ).toMatch(/^\d+$/);
    });

    it("shows a current decision's question under the title", async () => {
      const threads = [
        sidebarThread("t", {
          sectionId: "sec_a",
          title: "Needs a call",
          latestAttentionAt: RECENT,
        }),
      ];
      const slot = await mountHome({
        threads,
        analysis: { t: decisionFor(RECENT, "Ship it?") },
      });
      const band = await slot.findByRole("region", { name: "Up Next" });
      expect(within(band).getByText("Ship it?")).toBeTruthy();
      // The block implies the decision, so the row draws no mark for it.
      expect(within(band).queryByRole("img")).toBeNull();
    });

    it("adds threads whose agent left a recap, after the ones waiting", async () => {
      const slot = await mountHome({
        threads: [
          ...sample(),
          sidebarThread("done", {
            sectionId: "sec_b",
            title: "Finished work",
            isUnread: true,
            latestAttentionAt: minutes(10),
          }),
        ],
        recaps: { done: recapOf("complete") },
      });
      const band = await slot.findByRole("region", { name: "Up Next" });
      expect(links(band)).toEqual(["Asking task", "Finished work"]);
      // A row's name is what it shows: mark, title, workstream, age.
      expect(
        within(band).getByRole("link", {
          name: /Finished, unread.*Finished work.*Beta.*10 minutes ago/,
        }),
      ).toBeTruthy();
      expect(within(band).getByText("2")).toBeTruthy();
    });

    it("caps the block at five rows with a way to show the rest", async () => {
      const ids = ["a", "b", "c", "d", "e", "f", "g"];
      const slot = await mountHome({
        threads: ids.map((id, index) =>
          sidebarThread(id, {
            sectionId: "sec_a",
            title: `Ask ${id}`,
            hasPendingInteraction: true,
            latestAttentionAt: 100 + index,
          }),
        ),
      });
      const band = await slot.findByRole("region", { name: "Up Next" });
      expect(within(band).getAllByRole("link")).toHaveLength(5);
      fireEvent.click(
        within(band).getByRole("button", { name: "Show 2 more" }),
      );
      expect(within(band).getAllByRole("link")).toHaveLength(7);
      fireEvent.click(within(band).getByRole("button", { name: "Show less" }));
      expect(within(band).getAllByRole("link")).toHaveLength(5);
    });

    it("leaves snoozed threads out of the block and every group", async () => {
      const threads = sample();
      const slot = await mountHome({
        threads,
        snoozes: {
          ask: { until: Date.now() + 3_600_000, attentionAt: 0, at: 0 },
        },
      });
      await slot.findByRole("region", { name: "Workstreams" });
      expect(slot.queryByRole("region", { name: "Up Next" })).toBeNull();
      open(slot, /^Alpha/);
      expect(links(region(slot, "Alpha"))).toEqual(["Alpha one"]);
      open(slot, /^Snoozed/);
      expect(links(region(slot, "Snoozed"))).toEqual(["Asking task"]);
    });

    it("can be turned off in the sidebar settings", async () => {
      const slot = await mountHome({
        threads: sample(),
        prefs: { showForYou: false },
      });
      await slot.findByRole("region", { name: "Workstreams" });
      expect(slot.queryByRole("region", { name: "Up Next" })).toBeNull();
    });

    it("names the thread by its BB title, never the analysis goal", async () => {
      const slot = await mountHome({
        threads: [
          sidebarThread("t", {
            sectionId: "sec_a",
            title: "Fix the parser",
            hasPendingInteraction: true,
            latestAttentionAt: RECENT,
          }),
        ],
        analysis: {
          t: { ...decisionFor(RECENT), goal: "A different goal sentence" },
        },
      });
      const band = await slot.findByRole("region", { name: "Up Next" });
      expect(links(band)).toEqual(["Fix the parser"]);
      expect(slot.container.textContent).not.toContain("different goal");
    });
  });

  describe("workstream groups", () => {
    it("starts them closed, with the thread count, and opens one on tap", async () => {
      const slot = await mountHome({ threads: sample() });
      await slot.findByRole("region", { name: "Workstreams" });
      const alpha = region(slot, "Alpha");
      const header = within(alpha).getByRole("button", { name: /^Alpha/ });
      expect(header.getAttribute("aria-expanded")).toBe("false");
      // Closed headers carry the waiting count and the total.
      expect(within(alpha).getByText(/1 waiting on you/)).toBeTruthy();
      expect(header.textContent).toContain("2");
      expect(links(alpha)).toEqual([]);
      fireEvent.click(header);
      expect(header.getAttribute("aria-expanded")).toBe("true");
      expect(links(alpha)).toEqual(["Asking task", "Alpha one"]);
    });

    it("remembers what was opened on this device", async () => {
      const first = await mountHome({ threads: sample() });
      await first.findByRole("region", { name: "Workstreams" });
      open(first, /^Beta/);
      expect(JSON.parse(window.localStorage.getItem(HOME_STATE_KEY)!)).toEqual({
        "group:sec_b": true,
      });
      first.lifecycle.unmount();
      const second = await mountHome({ threads: sample() });
      await second.findByRole("region", { name: "Workstreams" });
      expect(links(region(second, "Beta"))).toEqual(["Beta one"]);
      expect(links(region(second, "Alpha"))).toEqual([]);
    });

    it("opens and closes every workstream at once", async () => {
      const slot = await mountHome({ threads: sample() });
      await slot.findByRole("region", { name: "Workstreams" });
      open(slot, "Expand all");
      expect(links(region(slot, "Alpha"))).toHaveLength(2);
      expect(links(region(slot, "Beta"))).toEqual(["Beta one"]);
      expect(links(region(slot, "Unfiled"))).toEqual(["Loose task"]);
      open(slot, "Collapse all");
      expect(links(region(slot, "Alpha"))).toEqual([]);
      expect(slot.getByRole("button", { name: "Expand all" })).toBeTruthy();
    });

    it("opens the only workstream there is, so a first look is never a lone closed header", async () => {
      const slot = await mountHome({
        threads: [
          sidebarThread("one", { title: "First", latestAttentionAt: 20 }),
          sidebarThread("two", { title: "Second", latestAttentionAt: 10 }),
        ],
      });
      await slot.findByRole("region", { name: "Unfiled" });
      expect(links(region(slot, "Unfiled"))).toEqual(["First", "Second"]);
    });

    it("files whole trees under the root's workstream, with the children toggled by a count", async () => {
      const slot = await mountHome({
        threads: [
          sidebarThread("root", {
            sectionId: "sec_a",
            title: "Manager",
            latestAttentionAt: minutes(3),
          }),
          sidebarThread("kid", {
            parentThreadId: "root",
            sectionId: "sec_b",
            title: "Delegate",
            latestAttentionAt: minutes(4),
          }),
          sidebarThread("other", {
            sectionId: "sec_b",
            title: "Other",
            latestAttentionAt: minutes(5),
          }),
        ],
        prefs: { threadCount: "always" },
      });
      await slot.findByRole("region", { name: "Workstreams" });
      open(slot, "Expand all");
      const alpha = region(slot, "Alpha");
      expect(links(alpha)).toEqual(["Manager", "Delegate"]);
      expect(links(region(slot, "Beta"))).toEqual(["Other"]);
      const fold = within(alpha).getByRole("button", {
        name: "Hide 1 thread under Manager",
      });
      fireEvent.click(fold);
      expect(links(alpha)).toEqual(["Manager"]);
      fireEvent.click(
        within(alpha).getByRole("button", {
          name: "Show 1 thread under Manager",
        }),
      );
      expect(links(alpha)).toEqual(["Manager", "Delegate"]);
    });

    it("pins a prioritized workstream open and hides the rest behind a toggle", async () => {
      const slot = await mountHome({
        threads: [
          sidebarThread("zask", {
            sectionId: "sec_z",
            title: "Zeta asks",
            hasPendingInteraction: true,
            latestAttentionAt: minutes(3),
          }),
          sidebarThread("z1", {
            sectionId: "sec_z",
            title: "Zeta quiet",
            latestAttentionAt: minutes(5),
          }),
          sidebarThread("bask", {
            sectionId: "sec_b",
            title: "Beta asks",
            hasPendingInteraction: true,
            latestAttentionAt: minutes(4),
          }),
          sidebarThread("a1", { sectionId: "sec_a", title: "Alpha one" }),
        ],
        order: { prioritized: ["sec_z"] },
      });
      const band = await slot.findByRole("region", { name: "Up Next" });
      // Focus: only the prioritized workstream's waiting thread shows.
      expect(links(band)).toEqual(["Zeta asks"]);
      expect(
        within(band).getByRole("img", {
          name: "Showing prioritized workstreams",
        }),
      ).toBeTruthy();
      expect(regionNames(slot)).toEqual(["Up Next", "Workstreams", "Zeta"]);
      expect(links(region(slot, "Zeta"))).toEqual(["Zeta asks", "Zeta quiet"]);
      const toggle = slot.getByRole("button", {
        name: /Show lower priority workstreams/,
      });
      // What Up Next left out stays counted, so nothing waits unseen.
      expect(toggle.textContent).toContain("1");
      fireEvent.click(toggle);
      expect(regionNames(slot)).toEqual([
        "Up Next",
        "Workstreams",
        "Zeta",
        "Alpha",
        "Beta",
      ]);
      // Revealed workstreams start closed.
      expect(links(region(slot, "Alpha"))).toEqual([]);
      fireEvent.click(
        slot.getByRole("button", { name: "Hide lower priority workstreams" }),
      );
      expect(regionNames(slot)).toEqual(["Up Next", "Workstreams", "Zeta"]);
    });

    it("orders workstreams by the sidebar's sort setting", async () => {
      const threads = [
        sidebarThread("a1", {
          sectionId: "sec_a",
          latestAttentionAt: minutes(30),
        }),
        sidebarThread("z1", {
          sectionId: "sec_z",
          latestAttentionAt: minutes(10),
        }),
        sidebarThread("b1", {
          sectionId: "sec_b",
          latestAttentionAt: minutes(20),
        }),
      ];
      const byName = await mountHome({ threads });
      await byName.findByRole("region", { name: "Workstreams" });
      expect(regionNames(byName).slice(1)).toEqual(["Alpha", "Beta", "Zeta"]);
      byName.lifecycle.unmount();
      const byActivity = await mountHome({
        threads,
        prefs: { groupSort: "activity" },
      });
      await byActivity.findByRole("region", { name: "Workstreams" });
      expect(regionNames(byActivity).slice(1)).toEqual([
        "Zeta",
        "Beta",
        "Alpha",
      ]);
    });

    it("leaves workstreams with no threads off the screen", async () => {
      const slot = await mountHome({
        threads: [
          sidebarThread("a1", { sectionId: "sec_a", title: "Alpha one" }),
        ],
      });
      await slot.findByRole("region", { name: "Workstreams" });
      expect(regionNames(slot)).toEqual(["Workstreams", "Alpha"]);
    });

    it("tucks quiet workstreams into a closed Dormant fold", async () => {
      const slot = await mountHome({
        threads: [
          sidebarThread("a1", { sectionId: "sec_a", title: "Alpha one" }),
          sidebarThread("old", {
            sectionId: "sec_b",
            title: "Old work",
            latestAttentionAt: Date.now() - 60 * 24 * 3_600_000,
          }),
        ],
      });
      await slot.findByRole("region", { name: "Workstreams" });
      expect(regionNames(slot)).toEqual(["Workstreams", "Alpha", "Dormant"]);
      expect(slot.queryByRole("region", { name: "Beta" })).toBeNull();
      open(slot, /^Dormant/);
      open(slot, /^Beta/);
      expect(links(region(slot, "Beta"))).toEqual(["Old work"]);
    });

    it("lists snoozed threads in a closed Snoozed fold with their wake times", async () => {
      const until = Date.now() + 2 * 24 * 3_600_000;
      const slot = await mountHome({
        threads: [
          sidebarThread("a1", { sectionId: "sec_a", title: "Alpha one" }),
          sidebarThread("later", {
            sectionId: "sec_a",
            title: "Later",
            latestAttentionAt: 5,
          }),
        ],
        snoozes: { later: { until, attentionAt: 5, at: 0 } },
      });
      await slot.findByRole("region", { name: "Workstreams" });
      const fold = region(slot, "Snoozed");
      expect(links(fold)).toEqual([]);
      fireEvent.click(within(fold).getByRole("button", { name: /^Snoozed/ }));
      expect(links(fold)).toEqual(["Later"]);
      expect(fold.textContent).not.toContain("w");
    });

    it("can hide the Snoozed fold", async () => {
      const slot = await mountHome({
        threads: [
          sidebarThread("a1", { sectionId: "sec_a" }),
          sidebarThread("later", { sectionId: "sec_a" }),
        ],
        snoozes: {
          later: { until: Date.now() + 3_600_000, attentionAt: 0, at: 0 },
        },
        prefs: { showSnoozed: false },
      });
      await slot.findByRole("region", { name: "Workstreams" });
      expect(slot.queryByRole("region", { name: "Snoozed" })).toBeNull();
    });
  });

  describe("details settings", () => {
    it.each([
      ["show", true],
      ["hover", false],
      ["hide", false],
    ] as const)(
      "shows ages when Timestamp is %s: %s",
      async (timestamps, shown) => {
        const slot = await mountHome({
          threads: sample(),
          prefs: { timestamps },
        });
        const band = await slot.findByRole("region", { name: "Up Next" });
        expect(band.querySelector(".ws-home-age") !== null).toBe(shown);
      },
    );

    const closedHeaderCounts = async (prefs: {
      threadCount: "always" | "collapsed" | "never";
      waitingCount: "always" | "collapsed" | "never";
    }) => {
      const slot = await mountHome({ threads: sample(), prefs });
      await slot.findByRole("region", { name: "Workstreams" });
      const alpha = region(slot, "Alpha");
      return {
        slot,
        waiting: () => within(alpha).queryByText(/waiting on you/) !== null,
        total: () => alpha.querySelector(".ws-home-total") !== null,
      };
    };

    it.each([
      ["always", [true, true]],
      ["collapsed", [false, true]],
      ["never", [false, false]],
    ] as const)(
      "shows the thread count %s, apart from the waiting count",
      async (when, [opened, closed]) => {
        const { slot, waiting, total } = await closedHeaderCounts({
          threadCount: when,
          waitingCount: "never",
        });
        expect([total(), waiting()]).toEqual([closed, false]);
        open(slot, /^Alpha/);
        expect([total(), waiting()]).toEqual([opened, false]);
      },
    );

    it.each([
      ["always", [true, true]],
      ["collapsed", [false, true]],
      ["never", [false, false]],
    ] as const)(
      "shows the waiting count %s, apart from the thread count",
      async (when, [opened, closed]) => {
        const { slot, waiting, total } = await closedHeaderCounts({
          threadCount: "never",
          waitingCount: when,
        });
        expect([waiting(), total()]).toEqual([closed, false]);
        open(slot, /^Alpha/);
        expect([waiting(), total()]).toEqual([opened, false]);
      },
    );
  });

  describe("states", () => {
    it("holds BB's place with a placeholder while threads load", async () => {
      const slot = await mountHome({ status: "loading" });
      const status = await slot.findByRole("status");
      expect(status.textContent).toContain("Loading threads");
      expect(
        slot.container
          .querySelector("[data-ws-home]")
          ?.getAttribute("data-ws-home"),
      ).toBe("takeover");
    });

    it("steps aside, leaving BB's list, when threads fail to load", async () => {
      const slot = await mountHome({ status: "error" });
      const alert = await slot.findByRole("alert");
      expect(alert.textContent).toContain("Couldn't load threads");
      expect(
        slot.container
          .querySelector("[data-ws-home]")
          ?.getAttribute("data-ws-home"),
      ).toBe("inline");
    });

    it("renders nothing, and hides BB's heading, when there is nothing to list", async () => {
      const slot = await mountHome({ threads: [] });
      await waitFor(() =>
        expect(
          slot.container
            .querySelector("[data-ws-home]")
            ?.getAttribute("data-ws-home"),
        ).toBe("hidden"),
      );
      expect(slot.queryByRole("region")).toBeNull();
    });

    it("does nothing for hidden helper threads", async () => {
      const slot = await mountHome({
        threads: [sidebarThread("h", { isHidden: true, sectionId: "sec_a" })],
      });
      await waitFor(() =>
        expect(
          slot.container
            .querySelector("[data-ws-home]")
            ?.getAttribute("data-ws-home"),
        ).toBe("hidden"),
      );
    });

    it("steps aside entirely when the phone Home preference is off", async () => {
      const slot = await mountHome({
        threads: sample(),
        prefs: { phoneHome: false },
      });
      await waitFor(() =>
        expect(
          slot.container
            .querySelector("[data-ws-home]")
            ?.getAttribute("data-ws-home"),
        ).toBe("hidden"),
      );
      expect(slot.queryByRole("region", { name: "Up Next" })).toBeNull();
    });
  });

  it("keeps a section element per workstream so sticky headers stay in their group", async () => {
    const slot = await mountHome({ threads: sample() });
    await slot.findByRole("region", { name: "Workstreams" });
    const alpha = region(slot, "Alpha");
    expect(alpha.querySelector("h3")).toBeTruthy();
    expect(alpha.firstElementChild?.tagName).toBe("H3");
  });
});

describe("Home screen first frame", () => {
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
  };

  it("holds the placeholder, not a frame drawn from defaults, until preferences and plugin state arrive", async () => {
    const hold = gate();
    const later = Date.now() + 3_600_000;
    const slot = await mountHome({
      threads: [
        sidebarThread("a1", { sectionId: "sec_a", title: "Alpha one" }),
        sidebarThread("later", {
          sectionId: "sec_a",
          title: "Snoozed one",
        }),
      ],
      snoozes: { later: { until: later, attentionAt: 0, at: 0 } },
      gates: { prefs: hold.promise, state: hold.promise },
    });
    // The threads are in, but what files them and what is snoozed is not.
    expect((await slot.findByRole("status")).textContent).toContain("Loading");
    expect(slot.queryByRole("region", { name: "Alpha" })).toBeNull();
    expect(
      slot.container
        .querySelector("[data-ws-home]")
        ?.getAttribute("data-ws-home"),
    ).toBe("takeover");
    hold.release();
    await slot.findAllByRole("region", { name: "Workstreams" });
    // Alpha is the only workstream with threads, so it starts open.
    expect(links(region(slot, "Alpha"))).toEqual(["Alpha one"]);
    expect(links(region(slot, "Snoozed"))).toEqual([]);
    expect(slot.queryByRole("status")).toBeNull();
  });

  it("then steps aside for a user who turned the section off", async () => {
    const hold = gate();
    const slot = await mountHome({
      threads: sample(),
      prefs: { phoneHome: false },
      gates: { prefs: hold.promise },
    });
    expect(await slot.findByRole("status")).toBeTruthy();
    hold.release();
    await waitFor(() =>
      expect(
        slot.container
          .querySelector("[data-ws-home]")
          ?.getAttribute("data-ws-home"),
      ).toBe("hidden"),
    );
  });
});

describe("Home screen with a prioritized workstream", () => {
  const zeta = (id: string, title: string, overrides = {}) =>
    sidebarThread(id, {
      sectionId: "sec_z",
      title,
      latestAttentionAt: minutes(5),
      ...overrides,
    });

  it("pins nothing, and hides nothing, while the prioritized workstream has no active threads", async () => {
    const until = Date.now() + 3_600_000;
    const slot = await mountHome({
      threads: [
        zeta("z1", "Zeta snoozed"),
        sidebarThread("a1", { sectionId: "sec_a", title: "Alpha one" }),
        sidebarThread("b1", { sectionId: "sec_b", title: "Beta one" }),
      ],
      snoozes: { z1: { until, attentionAt: 0, at: 0 } },
      order: { prioritized: ["sec_z"] },
    });
    await slot.findAllByRole("region", { name: "Workstreams" });
    expect(regionNames(slot)).toEqual([
      "Workstreams",
      "Alpha",
      "Beta",
      "Snoozed",
    ]);
    expect(
      slot.queryByRole("button", { name: /lower priority workstreams/ }),
    ).toBeNull();
  });

  it("keeps the focus count and neutral pills when Up Next is switched off", async () => {
    const slot = await mountHome({
      threads: [
        zeta("zask", "Zeta asks", { hasPendingInteraction: true }),
        sidebarThread("bask", {
          sectionId: "sec_b",
          title: "Beta asks",
          hasPendingInteraction: true,
          latestAttentionAt: minutes(4),
        }),
      ],
      prefs: { showForYou: false },
      order: { prioritized: ["sec_z"] },
    });
    await slot.findAllByRole("region", { name: "Workstreams" });
    expect(slot.queryByRole("region", { name: "Up Next" })).toBeNull();
    // What focus left out is still counted on the toggle...
    const toggle = slot.getByRole("button", {
      name: /Show lower priority workstreams/,
    });
    expect(toggle.textContent).toContain("1");
    fireEvent.click(toggle);
    // ...and the other workstream's waiting count recedes.
    const pill = within(region(slot, "Beta")).getByText(
      /waiting on you/,
    ).parentElement!;
    expect(pill.classList.contains("ws-home-pill-quiet")).toBe(true);
  });
});

describe("Home screen accessibility", () => {
  it("names a row by everything it shows, so a screen reader hears what a sighted user reads", async () => {
    const slot = await mountHome({
      threads: [
        sidebarThread("t", {
          sectionId: "sec_a",
          title: "Needs a call",
          latestAttentionAt: RECENT,
        }),
      ],
      analysis: { t: decisionFor(RECENT, "Ship it?") },
    });
    const band = await slot.findByRole("region", { name: "Up Next" });
    const row = within(band).getByRole("link");
    expect(row.getAttribute("aria-label")).toBeNull();
    expect(
      within(band).getByRole("link", {
        name: /Needs a call.*Alpha.*Ship it\?.*minute/,
      }),
    ).toBeTruthy();
  });

  it("states a closed header's counts in words and says when a workstream is prioritized", async () => {
    const slot = await mountHome({
      threads: [
        sidebarThread("a1", {
          sectionId: "sec_a",
          title: "Alpha ask",
          hasPendingInteraction: true,
          latestAttentionAt: minutes(3),
        }),
        sidebarThread("a2", {
          sectionId: "sec_a",
          title: "Alpha two",
          latestAttentionAt: minutes(9),
        }),
        sidebarThread("z1", { sectionId: "sec_z", title: "Zeta one" }),
      ],
      order: { prioritized: ["sec_z"] },
    });
    await slot.findAllByRole("region", { name: "Workstreams" });
    expect(
      slot.getByRole("button", { name: /^Zeta, prioritized/ }),
    ).toBeTruthy();
    fireEvent.click(
      slot.getByRole("button", { name: /Show lower priority workstreams/ }),
    );
    expect(
      slot.getByRole("button", {
        name: /^Alpha.*1 waiting on you.*2 threads/,
      }),
    ).toBeTruthy();
  });

  it("marks an unsent draft", async () => {
    const slot = await mountHome({
      threads: [
        sidebarThread("a1", { sectionId: "sec_a", title: "Alpha one" }),
        sidebarThread("a2", { sectionId: "sec_a", title: "Alpha two" }),
      ],
      drafts: ["a2"],
    });
    await slot.findAllByRole("region", { name: "Alpha" });
    const rows = within(region(slot, "Alpha")).getAllByRole("link");
    const draft = (title: string) =>
      rows
        .find((row) => row.textContent?.includes(title))
        ?.querySelector('[role="img"][aria-label="Unsent draft"]');
    expect(draft("Alpha two")).toBeTruthy();
    expect(draft("Alpha one")).toBeNull();
  });
});

describe("Home screen placement", () => {
  it("renders nothing in a wide window", async () => {
    const slot = await mountHome({ threads: sample(), placement: "bare" });
    await waitFor(() =>
      expect(
        slot.container
          .querySelector("[data-ws-home]")
          ?.getAttribute("data-ws-home"),
      ).toBe("hidden"),
    );
    expect(slot.queryByRole("region", { name: "Up Next" })).toBeNull();
  });

  it("renders below BB's list in a narrow window where BB's viewport isn't found", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query === "(max-width: 767px)",
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    try {
      const slot = await mountHome({ threads: sample(), placement: "bare" });
      await slot.findByRole("region", { name: "Up Next" });
      expect(
        slot.container
          .querySelector("[data-ws-home]")
          ?.getAttribute("data-ws-home"),
      ).toBe("inline");
    } finally {
      if (original) Object.defineProperty(window, "matchMedia", original);
      else delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });
});

describe("section registration", () => {
  it("registers one homepage section titled Workstreams", async () => {
    const { loadPluginApp } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
    expect(
      app.homepageSections.map(({ id, title }) => ({ id, title })),
    ).toEqual([{ id: "home", title: "Workstreams" }]);
    expect(section("x", "X").name).toBe("X");
  });
});
