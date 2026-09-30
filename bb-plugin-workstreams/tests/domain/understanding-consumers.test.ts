import { describe, expect, it } from "vitest";
import { analysisPrompt } from "../../src/domain/analysis.ts";
import { routePrompt } from "../../src/domain/router.ts";

const understanding =
  "Recap: The user says its implementation belongs to Workstreams. [evidence: obs-1] Uncertain whether it is independently released.";

describe("understanding consumers", () => {
  it("gives analysis cited scope context without making it triage authority", () => {
    const prompt = analysisPrompt({
      title: "Recap cards",
      workstream: { name: "Workstreams", description: null, subjects: [] },
      otherWorkstreams: ["Recap"],
      requests: [{ text: "Fix card spacing", initial: false }],
      lastAssistantText: "Spacing fixed.",
      understanding,
    });
    expect(prompt).toContain(understanding);
    expect(prompt).toContain("untrusted evidence");
    expect(prompt).toContain("state and needsYou still come from this thread");
    expect(prompt).toContain("Explicit current user statements outweigh");
  });

  it("lets routing reason about historical names while preserving uncertainty and explicit choices", () => {
    const prompt = routePrompt({
      prompt: "Improve Recap cards",
      workstreams: [{ name: "Workstreams", description: null, subjects: [] }],
      threads: [],
      pickedProjectHosts: null,
      understanding,
    });
    expect(prompt).toContain(understanding);
    expect(prompt).toContain("Explicit user choices remain authoritative");
    expect(prompt).toContain("return unsure");
  });

  it("bounds retrieved context before prompt assembly", () => {
    const prompt = routePrompt({
      prompt: "Fix it",
      workstreams: [],
      threads: [],
      pickedProjectHosts: null,
      understanding: "x".repeat(20_000),
    });
    expect(prompt).not.toContain("x".repeat(8001));
  });
});
