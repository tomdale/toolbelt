import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  attemptError,
  explainGrouping,
  filterReport,
  normalizationSteps,
  traceInput,
} from "../diagnostics";
import {
  classificationPrompt,
  classifyBatch,
  parseClassifications,
  type Analysis,
  type Context,
  type Thread,
} from "../model";
import { contextExcerpt } from "../context";
import {
  explainOrganize,
  planOrganize,
  planOrganizeRun,
  type LogEntry,
} from "../organize";

// Synthetic reproduction of the observed failure shape: nearly every thread
// shares one catch-all BB project, and that project's name is also a group.
const SHARED = "Home Ops";
const thread = (
  id: string,
  title: string,
  overrides: Partial<Thread> = {},
): Thread => ({
  id,
  title,
  project: SHARED,
  repository: null,
  status: "idle",
  updatedAt: 1,
  latestAttentionAt: 1,
  sectionId: null,
  parentThreadId: null,
  environmentPath: null,
  hasPendingInteraction: false,
  ...overrides,
});
const analysis = (groups: Record<string, string>): Analysis => ({
  at: 1,
  needsYouCount: 0,
  warnings: [],
  summaries: {},
  items: Object.entries(groups).map(([threadId, group]) => ({
    threadId,
    group,
    recap: "r",
    title: "t",
    updatedAt: 1,
    refreshed: true,
  })),
});
const sections = new Map([
  ["sec_ops", SHARED],
  ["sec_lumen", "Lumen"],
]);

describe("explainGrouping", () => {
  const threads = [
    thread("ops", "Home Ops — agent operations", { sectionId: "sec_ops" }),
    // A product manager spawned by the operations thread keeps its own
    // section, but the tree follows the operations root.
    thread("lumen-mgr", "Lumen — manager", {
      sectionId: "sec_lumen",
      parentThreadId: "ops",
    }),
    thread("lumen-worker", "Cache invalidation", {
      sectionId: "sec_lumen",
      parentThreadId: "lumen-mgr",
    }),
    // A manager root that a previous organize filed into the shared section.
    thread("beacon-mgr", "Beacon — manager", { sectionId: "sec_ops" }),
    // Not analyzed yet: named by its BB project.
    thread("fresh", "New unanalyzed thread"),
    // Control: an unsectioned manager root names its own group.
    thread("dock-mgr", "Dockside — manager"),
  ];
  const report = explainGrouping(
    threads,
    analysis({
      ops: SHARED,
      "lumen-mgr": "Lumen",
      "lumen-worker": "Lumen",
      "beacon-mgr": SHARED,
      "dock-mgr": "Dockside",
    }),
    sections,
  );
  const byId = new Map(report.threads.map((t) => [t.threadId, t]));

  it("names each thread's displayed group, root, and root source", () => {
    expect(byId.get("lumen-worker")).toMatchObject({
      classifiedGroup: "Lumen",
      sectionName: "Lumen",
      displayedGroup: SHARED,
      source: "section",
      rootThreadId: "ops",
      inherited: true,
      disagrees: true,
    });
    expect(byId.get("fresh")).toMatchObject({
      classifiedGroup: null,
      displayedGroup: SHARED,
      source: "project",
      inherited: false,
      disagrees: false,
    });
    expect(byId.get("dock-mgr")).toMatchObject({
      displayedGroup: "Dockside",
      source: "manager",
    });
  });

  it("summarizes how a catch-all group accumulated unrelated threads", () => {
    // The section bucket and the project-fallback bucket share a name but are
    // separate groups, so the page can show two groups with the same heading.
    expect(
      report.groups
        .filter((g) => g.name === SHARED)
        .map(
          ({
            id,
            threads,
            roots,
            sources,
            inherited,
            disagreeing,
            classifiedAs,
          }) => ({
            id,
            threads,
            roots,
            sources,
            inherited,
            disagreeing,
            classifiedAs,
          }),
        ),
    ).toEqual([
      {
        id: "section:sec_ops",
        threads: 4,
        roots: 2,
        sources: { section: 2 },
        inherited: 2,
        disagreeing: 2,
        classifiedAs: { [SHARED]: 2, Lumen: 2 },
      },
      {
        id: "product:home ops",
        threads: 1,
        roots: 1,
        sources: { project: 1 },
        inherited: 0,
        disagreeing: 0,
        classifiedAs: { "(not analyzed)": 1 },
      },
    ]);
    const findings = Object.fromEntries(
      report.findings
        .filter((f) => f.group === SHARED)
        .map((f) => [f.code, f.threadIds.sort()]),
    );
    expect(findings).toEqual({
      "project-fallback": ["fresh"],
      "classified-as-project": ["beacon-mgr", "ops"],
      "subtree-inheritance": ["lumen-mgr", "lumen-worker"],
      "section-overrides-manager-title": ["beacon-mgr"],
    });
  });

  it("omits titles unless requested, and redacts them when included", () => {
    expect(JSON.stringify(report)).not.toContain("Cache invalidation");
    const titled = explainGrouping(
      [thread("x", "Rotate token sk-abcdefghijklmnopqrstuvwx now")],
      null,
      new Map(),
      { titles: true },
    );
    expect(titled.threads[0].title).toBe("Rotate token [redacted] now");
  });

  it("filters to one thread or one displayed group", () => {
    const full = {
      grouping: report,
      classifier: null,
      organize: null,
      plan: { decisions: threads.map((t) => ({ threadId: t.id })) },
    };
    const one = filterReport(full, { threadId: "lumen-worker" });
    expect(one.grouping.threads.map((t) => t.threadId)).toEqual([
      "lumen-worker",
    ]);
    expect(one.grouping.findings.map((f) => f.code)).toEqual([
      "subtree-inheritance",
    ]);
    expect(one.plan.decisions).toEqual([{ threadId: "lumen-worker" }]);
    const group = filterReport(full, { group: "dockside" });
    expect(group.grouping.threads.map((t) => t.threadId)).toEqual(["dock-mgr"]);
  });
});

describe("classifier tracing", () => {
  const context = (id: string, overrides: Partial<Context> = {}): Context => ({
    ...thread(id, `Private title ${id}`),
    excerpts: contextExcerpt(
      "Private initial request",
      [
        { createdAt: 1, input: [{ type: "text", text: "Private follow-up" }] },
        { createdAt: 2, input: [{ type: "text", text: "Private latest" }] },
      ],
      "Private report",
    ),
    path: "/Users/someone/Code/lumen/",
    repository: "git@github.com:acme/lumen-app.git",
    timeline: "#1: a\n#2: b\n#3: c",
    ...overrides,
  });

  it("summarizes input structure without conversation content", () => {
    const input = traceInput({
      ...context("a"),
      pinnedGroup: SHARED,
      pinSource: "section",
      previousGroup: "Lumen",
    });
    expect(input).toEqual({
      project: SHARED,
      repository: "lumen-app",
      checkout: "lumen",
      excerptChars: context("a").excerpts.length,
      hasInitialRequest: true,
      recentRequests: 2,
      hasAssistantReport: true,
      timelineRequests: 3,
      previousGroup: "Lumen",
      pinnedGroup: SHARED,
      pinSource: "section",
      settled: false,
    });
    expect(JSON.stringify(input)).not.toMatch(/Private/);
  });

  it("requests evidence only for diagnosed runs and keeps the base prompt", () => {
    const records = [{ ...context("a"), id: "1" }];
    const base = classificationPrompt(records);
    expect(classificationPrompt(records, [], { basis: false })).toBe(base);
    expect(base).not.toContain('"basis"');
    const diagnosed = classificationPrompt(records, [], { basis: true });
    expect(diagnosed).toContain('"basis"');
    // The record JSON stays on the final line for the output contract.
    expect(diagnosed.slice(diagnosed.lastIndexOf("\n") + 1)).toBe(
      base.slice(base.lastIndexOf("\n") + 1),
    );
  });

  it("reports the model's group before a manual-section pin replaces it", async () => {
    const raw: unknown[] = [];
    const [result] = await classifyBatch(
      [{ ...context("a"), pinnedGroup: SHARED, pinSource: "section" }],
      async () =>
        JSON.stringify({
          items: [
            {
              threadId: "1",
              group: "Lumen",
              title: "Cache work",
              recap: "Working",
              state: "in_progress",
              basis: "checkout_path",
            },
          ],
        }),
      [],
      { basis: true, onRaw: (item) => raw.push(item) },
    );
    expect(result.group).toBe(SHARED);
    expect(result).not.toHaveProperty("basis");
    expect(raw).toMatchObject([
      { threadId: "a", group: "Lumen", basis: "checkout_path" },
    ]);
  });

  it("tolerates an unknown evidence category", () => {
    const [item] = parseClassifications(
      JSON.stringify({
        items: [
          {
            threadId: "1",
            group: "Lumen",
            title: "t",
            recap: "r",
            state: "done",
            basis: "vibes",
          },
        ],
      }),
      ["1"],
    );
    expect(item.basis).toBeUndefined();
  });

  it("categorizes rejected attempts without keeping their messages", () => {
    const parse = (text: string) => {
      try {
        parseClassifications(text, ["1"]);
      } catch (e) {
        return attemptError(e);
      }
    };
    expect(parse("not json")).toBe("invalid-json");
    expect(parse('{"items":[{"threadId":"1"}]}')).toBe("schema");
    expect(parse('{"items":[]}')).toBe("coverage");
    expect(attemptError(new Error("gateway down"))).toBe("call-failed");
    expect(attemptError(new z.ZodError([]))).toBe("schema");
  });

  it("records descriptor cleanup and typographic merges separately", () => {
    expect(normalizationSteps("Lumen plugin", "Lumen")).toEqual([
      { stage: "clean", from: "Lumen plugin", to: "Lumen" },
    ]);
    expect(normalizationSteps("lumen", "Lumen")).toEqual([
      { stage: "merge", from: "lumen", to: "Lumen" },
    ]);
    expect(normalizationSteps("Lumen", "Lumen")).toEqual([]);
  });
});

describe("organize explanations", () => {
  const withSection = (t: Thread, sectionName: string | null) => ({
    ...t,
    sectionName,
  });

  it("gives a reason for every thread the planner leaves alone", () => {
    const threads = [
      withSection(thread("new", "New"), null),
      withSection(thread("stale", "Stale", { updatedAt: 2 }), null),
      withSection(thread("kept", "Kept"), null),
      withSection(thread("filed", "Filed"), "Lumen"),
      withSection(thread("unknown", "Unknown"), null),
      withSection(thread("move", "Move"), null),
    ];
    const current = analysis({
      stale: "Lumen",
      kept: "Lumen",
      filed: "Lumen",
      unknown: "Unclassified",
      move: "Lumen",
    });
    current.items.find((i) => i.threadId === "kept")!.refreshed = false;
    const { actions, decisions } = explainOrganize(threads, current, new Set());
    expect(actions).toEqual(planOrganize(threads, current, new Set()));
    expect(
      Object.fromEntries(
        decisions.map((d) => [d.threadId, [d.planned, d.notes]]),
      ),
    ).toEqual({
      new: [[], ["not-analyzed"]],
      stale: [[], ["changed-since-analysis"]],
      kept: [[], ["not-refreshed"]],
      filed: [[], ["already-in-section"]],
      unknown: [[], ["unclassified"]],
      move: [["section"], []],
    });
  });

  it("explains a section move dropped to respect a later manual move", () => {
    const moved = thread("a", "A", { sectionId: "sec_manual" });
    const log: LogEntry[] = [
      {
        id: "1",
        at: 1,
        action: { kind: "section", threadId: "a", section: "Lumen" },
        result: "done",
        detail: "",
        undo: { workstreamsSectionId: "sec_lumen" },
        undone: false,
      },
    ];
    const { actions, decisions } = planOrganizeRun(
      [withSection(moved, "Manual")],
      analysis({ a: "Beacon" }),
      new Set(),
      log,
      new Map([["sec_manual", "Manual"]]),
    );
    expect(actions).toEqual([]);
    expect(decisions).toEqual([
      {
        threadId: "a",
        group: "Beacon",
        sectionName: "Manual",
        planned: [],
        notes: ["later-manual-move"],
      },
    ]);
  });
});
