import { describe, expect, it } from "vitest";
import {
  GOAL_MAX,
  RECAP_MAX,
  fullAnalysisPrompt,
  isCurrent,
  parseFullAnalysis,
  parseQuickAnalysis,
  quickAnalysisPrompt,
  type FullAnalysisInput,
} from "../../src/domain/analysis.ts";

const entities = [
  {
    id: "lumen",
    name: "Lumen",
    description: "Build tool",
    parentId: null,
    aliases: [],
  },
  {
    id: "cache",
    name: "Cache",
    description: "Build cache",
    parentId: "lumen",
    aliases: [],
  },
];

const base: FullAnalysisInput = {
  title: "Fix stale build cache",
  requests: [{ text: "The Lumen cache serves stale builds", initial: true }],
  lastAssistantText: "Found the invalidation bug; fixed it and tests pass.",
  mode: "full",
};

describe("Full analysis", () => {
  it("asks for status, goal, and topic after a new request with no report", () => {
    const prompt = fullAnalysisPrompt({
      ...base,
      topic: { entities, project: "Zebracorn", current: null },
    });
    expect(prompt).toContain('"recap": string');
    expect(prompt).toContain('"goal": string|null');
    expect(prompt).toContain('"subjectId": string|null');
    expect(prompt).toContain("[cache]");
    expect(prompt).not.toContain("scopeShift");
  });

  it("doesn't ask for status the agent already reported", () => {
    const prompt = fullAnalysisPrompt({
      ...base,
      report: { state: "complete", headline: "Fixed the cache", latest: [] },
    });
    expect(prompt).toContain("reported this turn as complete");
    expect(prompt).not.toContain('"recap": string');
    const parsed = parseFullAnalysis('{"goal":"Stale build cache"}', {
      ...base,
      report: { state: "complete", headline: "x", latest: [] },
    });
    expect(parsed).toEqual({
      status: null,
      goal: "Stale build cache",
      topic: null,
    });
  });

  it("asks only for status when no new request arrived", () => {
    const input: FullAnalysisInput = { ...base, mode: "status" };
    const prompt = fullAnalysisPrompt({
      ...input,
      topic: { entities, project: null, current: null },
    });
    expect(prompt).not.toContain('"goal"');
    expect(prompt).not.toContain('"subjectId"');
    expect(
      parseFullAnalysis('{"recap":"Waiting on CI","state":"blocked"}', input),
    ).toEqual({
      status: { recap: "Waiting on CI", state: "blocked", needsYou: null },
      goal: null,
      topic: null,
    });
  });

  it("asks whether scope shifted only for an inherited topic", () => {
    const prompt = fullAnalysisPrompt({
      ...base,
      topic: {
        entities,
        project: null,
        current: { id: "lumen", label: "Lumen", inherited: true },
      },
    });
    expect(prompt).toContain("scopeShift");
    expect(prompt).toContain("Current topic: Lumen [lumen]");
  });

  it("parses a topic, anchors a proposal, and rejects an unknown one", () => {
    const input: FullAnalysisInput = {
      ...base,
      topic: { entities, project: null, current: null },
    };
    const answer = (fields: object) =>
      JSON.stringify({ recap: "Done", state: "done", goal: "Cache", ...fields });
    expect(parseFullAnalysis(answer({ subjectId: "cache" }), input).topic).toEqual(
      { subjectId: "cache", proposed: null, scopeShift: false },
    );
    expect(
      parseFullAnalysis(
        answer({
          proposed: { name: "Cache", parentId: "lumen", description: "" },
        }),
        input,
      ).topic,
    ).toEqual({ subjectId: "cache", proposed: null, scopeShift: false });
    expect(() =>
      parseFullAnalysis(answer({ subjectId: "invented" }), input),
    ).toThrow();
  });

  it("clips the recap, keeps an ask only for a decision, and drops a long goal", () => {
    const parsed = parseFullAnalysis(
      "```json\n" +
        JSON.stringify({
          recap: "x ".repeat(200),
          state: "review",
          needsYou: "Approve?",
          goal: "y".repeat(GOAL_MAX + 1),
        }) +
        "\n```",
      base,
    );
    expect(parsed.status!.recap.length).toBeLessThanOrEqual(RECAP_MAX);
    expect(parsed.status!.needsYou).toBeNull();
    expect(parsed.goal).toBeNull();
    expect(() => parseFullAnalysis('{"state":"done"}', base)).toThrow();
  });

  it("redacts secrets and never shows a project outside the topic part", () => {
    const prompt = fullAnalysisPrompt({
      ...base,
      requests: [
        { text: "use key sk-abcdefghijklmnopqrstuvwxyz", initial: true },
      ],
    });
    expect(prompt).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(prompt).not.toContain("Project:");
  });
});

describe("Quick analysis", () => {
  it("shows the first request, the project, and the topic tree", () => {
    const prompt = quickAnalysisPrompt({
      request: "Fix the Lumen cache",
      project: "Zebracorn",
      entities,
    });
    expect(prompt).toContain("Fix the Lumen cache");
    expect(prompt).toContain("Project: Zebracorn");
    expect(prompt).toContain("[lumen]");
  });

  it("parses a goal and topic, treating missing fields as none", () => {
    expect(
      parseQuickAnalysis('{"goal":"Lumen cache.","subjectId":"cache"}', {
        entities,
      }),
    ).toEqual({ goal: "Lumen cache", subjectId: "cache", proposed: null });
    expect(parseQuickAnalysis("{}", { entities })).toEqual({
      goal: null,
      subjectId: null,
      proposed: null,
    });
  });
});

describe("freshness", () => {
  it("is current only while idle at the analyzed revision", () => {
    const stored = { revision: 100 };
    expect(isCurrent(stored, { status: "idle", latestAttentionAt: 100 })).toBe(
      true,
    );
    expect(isCurrent(stored, { status: "active", latestAttentionAt: 100 })).toBe(
      false,
    );
    expect(isCurrent(stored, { status: "idle", latestAttentionAt: 101 })).toBe(
      false,
    );
  });
});
