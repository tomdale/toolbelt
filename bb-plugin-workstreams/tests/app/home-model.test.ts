// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMPACT_HOME_VIEWPORT,
  detectPlacement,
  homeMode,
} from "../../src/app/home/layout.ts";
import {
  descendantCount,
  planHome,
  prioritizedSet,
  startsOpen,
  unfoldedRows,
} from "../../src/app/home/model.ts";
import { DAY_MS, projectWorkstreams } from "../../src/domain/project.ts";
import { thread } from "../domain/fixtures.ts";

const now = 100 * DAY_MS;
const sections = [
  { id: "sec_a", name: "Alpha" },
  { id: "sec_b", name: "Beta" },
  { id: "sec_empty", name: "Empty" },
];
const baseOptions = {
  recaps: {},
  prioritized: new Set<string>(),
  groupSort: "alphabetical" as const,
  showUpNext: true,
  showSnoozed: true,
};
const ids = (rows: readonly { thread: { id: string } }[]) =>
  rows.map((row) => row.thread.id);

describe("planHome", () => {
  it("lists workstreams with threads, Unfiled, then Dormant, and skips empty ones", () => {
    const projection = projectWorkstreams(
      [
        thread("a1", { sectionId: "sec_a", latestAttentionAt: now - 1 }),
        thread("loose", { latestAttentionAt: now - 2 }),
        thread("old", {
          sectionId: "sec_b",
          latestAttentionAt: now - 60 * DAY_MS,
        }),
      ],
      sections,
      { now },
    );
    const plan = planHome(projection, baseOptions);
    expect(plan.pinned).toEqual([]);
    expect(plan.populated.map((group) => group.name)).toEqual(["Alpha"]);
    expect(plan.unfiled?.name).toBe("Unfiled");
    expect(plan.dormant.map((group) => group.name)).toEqual(["Beta"]);
    expect(plan.populatedCount).toBe(2);
    expect(plan.hasLower).toBe(true);
    expect(plan.isEmpty).toBe(false);
  });

  it("is empty when only workstreams with no threads exist", () => {
    const plan = planHome(
      projectWorkstreams([], sections, { now }),
      baseOptions,
    );
    expect(plan.isEmpty).toBe(true);
    expect(plan.unfiled).toBeNull();
  });

  it("is not empty when only a snoozed thread remains, unless the fold is hidden", () => {
    const projection = projectWorkstreams(
      [thread("later", { sectionId: "sec_a", latestAttentionAt: now })],
      sections,
      { now, snoozedUntil: () => now + DAY_MS },
    );
    expect(planHome(projection, baseOptions).isEmpty).toBe(false);
    expect(planHome(projection, baseOptions).snoozed).toHaveLength(1);
    expect(
      planHome(projection, { ...baseOptions, showSnoozed: false }).isEmpty,
    ).toBe(true);
  });

  it("tiers prioritized workstreams above the rest, which are lower priority", () => {
    const projection = projectWorkstreams(
      [
        thread("a1", { sectionId: "sec_a", latestAttentionAt: now }),
        thread("b1", { sectionId: "sec_b", latestAttentionAt: now }),
      ],
      sections,
      {
        now,
        order: { workstreams: [], threads: {}, prioritized: ["sec_b"] },
      },
    );
    const plan = planHome(projection, {
      ...baseOptions,
      prioritized: new Set(["sec_b"]),
    });
    expect(plan.tiered).toBe(true);
    expect(plan.pinned.map((group) => group.name)).toEqual(["Beta"]);
    expect(plan.populated.map((group) => group.name)).toEqual(["Alpha"]);
    expect(startsOpen(plan, plan.pinned[0]!)).toBe(true);
    expect(startsOpen(plan, plan.populated[0]!)).toBe(false);
  });

  it("reports what Up Next left out under prioritized focus", () => {
    const projection = projectWorkstreams(
      [
        thread("pinned", {
          sectionId: "sec_a",
          hasPendingInteraction: true,
          latestAttentionAt: now - 1,
        }),
        thread("elsewhere", {
          sectionId: "sec_b",
          hasPendingInteraction: true,
          latestAttentionAt: now - 2,
        }),
      ],
      sections,
      { now },
    );
    const plan = planHome(projection, {
      ...baseOptions,
      prioritized: new Set(["sec_a"]),
    });
    expect(ids(plan.upNext!.rows)).toEqual(["pinned"]);
    expect(plan.focus).toEqual({ active: true, elsewhere: 1 });
  });

  it("keeps the focus bookkeeping when Up Next is switched off", () => {
    const projection = projectWorkstreams(
      [
        thread("pinned", { sectionId: "sec_a", hasPendingInteraction: true }),
        thread("elsewhere", {
          sectionId: "sec_b",
          hasPendingInteraction: true,
        }),
      ],
      sections,
      { now },
    );
    const plan = planHome(projection, {
      ...baseOptions,
      prioritized: new Set(["sec_a"]),
      showUpNext: false,
    });
    expect(plan.upNext).toBeNull();
    expect(plan.focus).toEqual({ active: true, elsewhere: 1 });
  });

  it("tiers nothing while the prioritized workstream has no active threads", () => {
    const projection = projectWorkstreams(
      [
        thread("snoozed", { sectionId: "sec_a", latestAttentionAt: now }),
        thread("b1", { sectionId: "sec_b", latestAttentionAt: now }),
      ],
      sections,
      {
        now,
        snoozedUntil: (t) => (t.id === "snoozed" ? now + DAY_MS : undefined),
        order: { workstreams: [], threads: {}, prioritized: ["sec_a"] },
      },
    );
    const plan = planHome(projection, {
      ...baseOptions,
      prioritized: new Set(["sec_a"]),
    });
    expect(plan.pinned).toEqual([]);
    expect(plan.tiered).toBe(false);
    expect(plan.populated.map((group) => group.name)).toEqual(["Beta"]);
  });

  it("leaves Up Next out when it is switched off", () => {
    const projection = projectWorkstreams(
      [thread("ask", { sectionId: "sec_a", hasPendingInteraction: true })],
      sections,
      { now },
    );
    expect(planHome(projection, baseOptions).upNext).not.toBeNull();
    expect(
      planHome(projection, { ...baseOptions, showUpNext: false }).upNext,
    ).toBeNull();
  });

  it("opens the only workstream there is, and no others", () => {
    const one = planHome(
      projectWorkstreams(
        [thread("a1", { sectionId: "sec_a", latestAttentionAt: now })],
        sections,
        { now },
      ),
      baseOptions,
    );
    expect(startsOpen(one, one.populated[0]!)).toBe(true);
    const two = planHome(
      projectWorkstreams(
        [
          thread("a1", { sectionId: "sec_a", latestAttentionAt: now }),
          thread("b1", { sectionId: "sec_b", latestAttentionAt: now }),
        ],
        sections,
        { now },
      ),
      baseOptions,
    );
    expect(two.populated.map((group) => startsOpen(two, group))).toEqual([
      false,
      false,
    ]);
  });
});

describe("prioritizedSet", () => {
  it("drops workstreams that no longer exist", () => {
    expect([
      ...prioritizedSet(
        { workstreams: [], threads: {}, prioritized: ["sec_a", "gone"] },
        sections,
      ),
    ]).toEqual(["sec_a"]);
  });
});

describe("tree rows", () => {
  const projection = projectWorkstreams(
    [
      thread("root", { sectionId: "sec_a", latestAttentionAt: now }),
      thread("kid", { parentThreadId: "root", createdAt: 1 }),
      thread("grandkid", { parentThreadId: "kid", createdAt: 2 }),
      thread("sibling", { parentThreadId: "root", createdAt: 3 }),
      thread("next", { sectionId: "sec_a", latestAttentionAt: now - 1 }),
    ],
    sections,
    { now },
  );
  const rows = projection.groups.find((group) => group.id === "sec_a")!.rows;

  it("lists a tree in order and counts what sits beneath each thread", () => {
    expect(ids(rows)).toEqual(["root", "kid", "grandkid", "sibling", "next"]);
    expect(rows.map((_, index) => descendantCount(rows, index))).toEqual([
      3, 1, 0, 0, 0,
    ]);
  });

  it("drops rows beneath a folded ancestor only", () => {
    const folded = (id: string) => (row: (typeof rows)[number]) =>
      row.thread.id === id;
    expect(ids(unfoldedRows(rows, folded("root")))).toEqual(["root", "next"]);
    expect(ids(unfoldedRows(rows, folded("kid")))).toEqual([
      "root",
      "kid",
      "sibling",
      "next",
    ]);
    expect(ids(unfoldedRows(rows, () => false))).toHaveLength(5);
  });
});

describe("placement", () => {
  it("is compact inside BB's compact home viewport", () => {
    document.body.innerHTML = `<div data-testid="root-compose-compact-scroll-viewport"><span id="in"></span></div><span id="out"></span>`;
    expect(document.querySelector(COMPACT_HOME_VIEWPORT)).not.toBeNull();
    expect(detectPlacement(document.getElementById("in"), false)).toBe(
      "compact",
    );
    expect(detectPlacement(document.getElementById("out"), true)).toBe(
      "narrow",
    );
    expect(detectPlacement(document.getElementById("out"), false)).toBe("wide");
    expect(detectPlacement(null, false)).toBe("wide");
  });

  it.each([
    ["compact", true, "loading", false, "takeover"],
    ["compact", true, "ready", true, "takeover"],
    ["compact", true, "ready", false, "hidden"],
    ["compact", true, "error", false, "inline"],
    ["compact", false, "ready", true, "hidden"],
    ["narrow", true, "ready", true, "inline"],
    ["narrow", true, "loading", false, "hidden"],
    ["narrow", true, "error", false, "inline"],
    ["wide", true, "ready", true, "hidden"],
  ] as const)(
    "%s, enabled %s, %s, content %s → %s",
    (placement, enabled, status, hasContent, expected) => {
      expect(homeMode({ placement, enabled, status, hasContent })).toBe(
        expected,
      );
    },
  );
});

describe("home.css", () => {
  const css = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../src/app/home/home.css",
    ),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  /** Every selector in a style rule, split at top-level commas. */
  const selectors = [...css.matchAll(/(^|[};])\s*([^@{};][^{};]*)\{/g)].flatMap(
    (match) => {
      const parts: string[] = [];
      let depth = 0;
      let current = "";
      for (const character of match[2]!) {
        if (character === "(") depth += 1;
        if (character === ")") depth -= 1;
        if (character === "," && depth === 0) {
          parts.push(current.trim());
          current = "";
        } else current += character;
      }
      parts.push(current.trim());
      return parts.filter(Boolean);
    },
  );
  const touchesBb = (selector: string) =>
    /root-compose-|plugin-homepage-sections|data-bb-plugin-root/.test(selector);

  it("restyles BB's markup only while the section is mounted there", () => {
    const rules = selectors.filter(touchesBb);
    expect(rules.length).toBeGreaterThanOrEqual(5);
    for (const selector of rules)
      expect(selector, selector).toMatch(/:has\([\s\S]*\[data-ws-home=/);
  });

  it("hides BB's list and spacer only in takeover mode", () => {
    const hidden = selectors.filter((selector) =>
      /mobile-recents|recents-offset/.test(selector),
    );
    expect(hidden.length).toBeGreaterThan(0);
    for (const selector of hidden)
      expect(selector).toContain('[data-ws-home="takeover"]');
  });

  it("lifts the viewport past BB's inline top, without adding the inset BB's shell already pads", () => {
    expect(css).toMatch(/top:\s*56px\s*!important/);
    expect(css).not.toMatch(/safe-area-inset-top/);
  });

  it("hides BB's section wrapper only when our hidden section is the only one in it", () => {
    const wrapper = selectors.filter((selector) =>
      selector.startsWith('[data-testid="plugin-homepage-sections"]:has('),
    );
    const hides = wrapper.filter((selector) =>
      /:not\(:has\(> section \+ section\)\)/.test(selector),
    );
    expect(hides).toHaveLength(1);
    expect(hides[0]).toContain('[data-ws-home="hidden"]');
  });

  /** Whether a :has() sits inside another :has(), however deep. */
  function nestsHas(selector: string): boolean {
    const open: boolean[] = [];
    for (const part of selector.split(/(:has\(|:is\(|:not\(|:where\(|\(|\))/)) {
      if (part === ":has(") {
        if (open.includes(true)) return true;
        open.push(true);
      } else if (/^(:is\(|:not\(|:where\(|\()$/.test(part)) open.push(false);
      else if (part === ")") open.pop();
    }
    return false;
  }

  it("never nests :has() inside :has(), which is invalid and would void every rule a minifier merged with it", () => {
    expect(nestsHas("a:has(b:not(:has(c)))")).toBe(true);
    expect(nestsHas("a:has(> b > :is(c, d)):not(:has(e))")).toBe(false);
    for (const selector of selectors)
      expect(nestsHas(selector), selector).toBe(false);
  });

  it("sizes type with BB's tokens, never raw pixel sizes", () => {
    const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1]!);
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes)
      expect(size, size).toMatch(/^(inherit|var\(--text-(2xs|xs|sm|base),)/);
  });

  it("gives every control at least a 44px target", () => {
    for (const selector of [
      ".ws-home-group-head > button",
      ".ws-home-lower-toggle",
      ".ws-home-more",
      ".ws-home-text-button",
    ]) {
      const rule = css.match(
        new RegExp(`${selector.replace(/[.>]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
      );
      expect(rule, selector).not.toBeNull();
      expect(rule![1], selector).toMatch(/min-height:\s*(4[4-9]|[5-9]\d)px/);
    }
  });
});
