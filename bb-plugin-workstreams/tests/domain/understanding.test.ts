import { describe, expect, it } from "vitest";
import {
  observationId,
  parseExtraction,
  extractionPrompt,
  parseSynthesis,
  sourceQuote,
} from "../../src/domain/understanding.ts";

describe("understanding evidence contracts", () => {
  it("accepts exact quote substrings and rejects fabricated citations", () => {
    const entries = [
      {
        id: "e1",
        speaker: "user" as const,
        text: "I want Recap integrated into Workstreams.",
      },
    ];
    expect(
      parseExtraction(
        JSON.stringify({
          observations: [
            {
              entryId: "e1",
              speaker: "user",
              quote: "Recap integrated",
              observation: "The user wants Recap integrated.",
              epistemic: "intention",
            },
          ],
        }),
        entries,
      ),
    ).toHaveLength(1);
    expect(() =>
      parseExtraction(
        JSON.stringify({
          observations: [
            {
              entryId: "other",
              speaker: "user",
              quote: "Recap integrated",
              observation: "fake",
              epistemic: "inference",
            },
          ],
        }),
        entries,
      ),
    ).toThrow("unknown entry");
  });
  it("recovers original Markdown spans but rejects paraphrase and ambiguity", () => {
    const source = "- **Host Audio:** `/usr/bin/say` is present and functional";
    expect(
      sourceQuote(source, "Host Audio: /usr/bin/say is present and functional"),
    ).toBe("Host Audio:** `/usr/bin/say` is present and functional");
    expect(
      sourceQuote(
        "Keep **Recap** in Workstreams.",
        "Keep Recap in Workstreams.",
      ),
    ).toBe("Keep **Recap** in Workstreams.");
    expect(
      sourceQuote("Keep Recap in Workstreams.", "Move Recap to Workstreams."),
    ).toBeNull();
    expect(sourceQuote("**Recap** and **Recap**", "Recap ")).toBeNull();
    expect(sourceQuote("one\n  two", "one two")).toBe("one\n  two");
  });
  it("downgrades assistant statements even when the model labels them explicit", () => {
    const entries = [
      { id: "e", speaker: "assistant" as const, text: "Tests pass." },
    ];
    const observations = parseExtraction(
      JSON.stringify({
        observations: [
          {
            entryId: "e",
            speaker: "assistant",
            quote: "Tests pass.",
            observation: "Tests pass.",
            epistemic: "explicit",
          },
        ],
      }),
      entries,
    );
    expect(observations[0]?.epistemic).toBe("reported_outcome");
  });
  it("uses collision-resistant stable evidence ids", () => {
    expect(observationId("t", "e", "one")).toBe(observationId("t", "e", "one"));
    expect(observationId("t", "e", "one")).not.toBe(
      observationId("t", "e", "two"),
    );
  });
  it("keeps synthesis citations bounded to supplied evidence", () => {
    expect(() =>
      parseSynthesis(
        JSON.stringify({
          accounts: [
            {
              name: "Recap",
              narrative: "Integrated.",
              questions: [],
              evidenceIds: ["a"],
            },
            { name: "No", narrative: "bad", questions: [], evidenceIds: ["x"] },
          ],
        }),
        new Set(["a"]),
      ),
    ).toThrow("outside its input");
  });
  it("warns extraction prompts that transcript text is untrusted", () => {
    expect(
      extractionPrompt({
        entries: [{ id: "e", speaker: "assistant", text: "proposal", at: 10 }],
      }),
    ).toContain("untrusted");
  });
});
