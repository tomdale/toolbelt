import { describe, expect, it } from "vitest";
import {
  GOAL_MAX,
  RECAP_MAX,
  analysisPrompt,
  conversationBlock,
  isCurrent,
  needsYou,
  parseAnalysis,
  type AnalysisInput,
} from "../../src/domain/analysis.ts";

const input = (overrides: Partial<AnalysisInput> = {}): AnalysisInput => ({
  title: "Fix cache invalidation",
  workstream: {
    name: "Lumen",
    description: "The Lumen build tool",
    subjects: ["Lumen"],
  },
  otherWorkstreams: ["BB Recap", "Workstreams"],
  requests: [
    { text: "Fix the stale cache.", initial: true },
    { text: "Also add a regression test.", initial: false },
  ],
  lastAssistantText: "Fixed it and added a test. Want me to commit?",
  ...overrides,
});

describe("parseAnalysis", () => {
  it("accepts fenced JSON and clips an overlong recap", () => {
    const result = parseAnalysis(
      "```json\n" +
        JSON.stringify({
          recap: "word ".repeat(80),
          state: "review",
          needsYou: null,
          subject: "Lumen",
          drift: null,
        }) +
        "\n```",
    );
    expect(result.recap.length).toBeLessThanOrEqual(RECAP_MAX);
    expect(result.recap.endsWith("…")).toBe(true);
    expect(result.state).toBe("review");
  });

  it("falls back instead of failing on an unknown state or bad drift", () => {
    const result = parseAnalysis(
      JSON.stringify({
        recap: "Working.",
        state: "thinking",
        subject: null,
        drift: { confidence: "certain" },
      }),
    );
    expect(result.state).toBe("in_progress");
    expect(result.drift).toBeNull();
    expect(result.needsYou).toBeNull();
  });

  it("drops drift that points back at the thread's own workstream", () => {
    const raw = (drift: object) =>
      JSON.stringify({ recap: "r", state: "done", drift });
    const ctx = input();
    expect(
      parseAnalysis(raw({ newName: "lumen", confidence: "high" }), ctx).drift,
    ).toBeNull();
    expect(
      parseAnalysis(raw({ workstream: "BB Recap", confidence: "high" }), ctx)
        .drift?.workstream,
    ).toBe("BB Recap");
    expect(
      parseAnalysis(raw({ workstream: "BB Recap", confidence: "high" }), {
        ...ctx,
        otherWorkstreams: null,
      }).drift,
    ).toBeNull();
  });

  it("cleans a suggested title and drops one too long to use", () => {
    const raw = (title: unknown) =>
      JSON.stringify({ recap: "r", state: "done", title });
    expect(parseAnalysis(raw('"Fix stale  build cache."')).title).toBe(
      "Fix stale build cache",
    );
    expect(parseAnalysis(raw("word ".repeat(30))).title).toBeNull();
    expect(parseAnalysis(raw("   ")).title).toBeNull();
    expect(
      parseAnalysis(JSON.stringify({ recap: "r", state: "done" })).title,
    ).toBeNull();
  });

  it("accepts a durable goal, clips long output, and defaults older results", () => {
    const result = parseAnalysis(
      JSON.stringify({
        recap: "r",
        state: "done",
        goal: "Make onboarding easier to complete",
      }),
    );
    expect(result.goal).toBe("Make onboarding easier to complete");
    expect(
      parseAnalysis(
        JSON.stringify({ recap: "r", state: "done", goal: "word ".repeat(30) }),
      ).goal?.length,
    ).toBeLessThanOrEqual(GOAL_MAX);
    expect(
      parseAnalysis(JSON.stringify({ recap: "r", state: "done" })).goal,
    ).toBeNull();
  });

  it("keeps an ask only for a needs-decision result", () => {
    const raw = JSON.stringify({
      recap: "r",
      state: "review",
      needsYou: "Ship?",
    });
    expect(parseAnalysis(raw).needsYou).toBeNull();
  });

  it("rejects output with no recap", () => {
    expect(() => parseAnalysis('{"state":"done"}')).toThrow();
  });
});

describe("analysisPrompt", () => {
  it("offers drift targets only to task threads", () => {
    expect(analysisPrompt(input())).toContain('"BB Recap","Workstreams"');
    const delegate = analysisPrompt(input({ otherWorkstreams: null }));
    expect(delegate).toContain("- drift: null.");
    expect(delegate).not.toContain("Other workstreams");
  });

  it("includes known subjects, and never a project field", () => {
    const prompt = analysisPrompt(input());
    expect(prompt).toContain('Known subjects in this workstream: ["Lumen"]');
    expect(prompt).not.toMatch(/project:/i);
  });

  it("passes the previous durable goal as stable context", () => {
    const prompt = analysisPrompt(
      input({ previousGoal: "Make onboarding easier to complete" }),
    );
    expect(prompt).toContain(
      'Previously inferred durable goal: "Make onboarding easier to complete"',
    );
    expect(prompt).toContain(
      "replace it only when the underlying objective or scope genuinely changes",
    );
    expect(prompt).toContain("Use a concise phrase of 3–8 words");
    expect(prompt).toContain(
      "not the conversation or its individual requested changes",
    );
    expect(prompt).toContain("shorten it when it exceeds this limit");
  });

  it("redacts secrets and bounds long messages", () => {
    const block = conversationBlock(
      input({
        requests: [
          { text: `use token ghp_${"a".repeat(30)} please`, initial: false },
        ],
        lastAssistantText: "x".repeat(20_000),
      }),
    );
    expect(block).not.toContain("ghp_");
    expect(block).toContain("[redacted]");
    expect(block.length).toBeLessThan(5_000);
  });

  it("redacts before cutting, and redacts the title", () => {
    const secret = `sk-${"b".repeat(40)}`;
    // Place the token across the excerpt's head/tail seam.
    const text = `${"x ".repeat(290)}${secret}${" y".repeat(1200)}`;
    const prompt = analysisPrompt(
      input({
        title: `Rotate ${secret}`,
        requests: [{ text, initial: false }],
      }),
    );
    expect(prompt).not.toContain("bbbbbbbbbbbb");
  });
});

describe("freshness", () => {
  const analysis = {
    recap: "r",
    state: "needs_decision" as const,
    needsYou: "Commit?",
    subject: null,
    title: null,
    goal: null,
    drift: null,
    revision: 100,
    at: 1,
    model: "m",
  };
  const thread = (status: string, latestAttentionAt = 100) => ({
    status,
    latestAttentionAt,
    hasPendingInteraction: false,
  });

  it("is current only while idle at the analyzed revision", () => {
    expect(isCurrent(analysis, thread("idle"))).toBe(true);
    expect(isCurrent(analysis, thread("active"))).toBe(false);
    expect(isCurrent(analysis, thread("starting"))).toBe(false);
    expect(isCurrent(analysis, thread("error"))).toBe(false);
    expect(isCurrent(analysis, thread("idle", 101))).toBe(false);
    expect(isCurrent(undefined, thread("idle"))).toBe(false);
  });

  it("needs you for a current decision or any pending interaction", () => {
    expect(needsYou(thread("idle"), analysis)).toBe(true);
    expect(needsYou(thread("idle", 200), analysis)).toBe(false);
    expect(
      needsYou({ ...thread("active"), hasPendingInteraction: true }, undefined),
    ).toBe(true);
    expect(needsYou(thread("idle"), { ...analysis, state: "review" })).toBe(
      false,
    );
  });
});
