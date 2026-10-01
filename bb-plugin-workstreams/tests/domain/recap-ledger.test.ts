import { expect, it } from "vitest";
import {
  parseRecap,
  parseRecapLedger,
  recapPrompt,
} from "../../src/domain/recap.ts";

it("parses one labeled line per item", () => {
  expect(
    parseRecapLedger("Goal: Building X.\nLatest: A\nLatest: B\nOpen: C"),
  ).toEqual({
    goal: "Building X.",
    latest: ["A", "B"],
    review: [],
    open: ["C"],
    done: [],
  });
});

it("parses headings followed by item lines", () => {
  expect(
    parseRecapLedger("Goal: Building X.\nLatest:\nA\n- B\nDone:\nD"),
  ).toEqual({
    goal: "Building X.",
    latest: ["A", "B"],
    review: [],
    open: [],
    done: ["D"],
  });
});

it("parses review checks separately from unfinished work", () => {
  const review = "Open Recent; confirm only top-level threads appear";
  expect(
    parseRecapLedger(
      `Goal: Filtering threads\nReview: ${review}\nOpen: Ship release`,
    ),
  ).toEqual({
    goal: "Filtering threads",
    latest: [],
    review: [review],
    open: ["Ship release"],
    done: [],
  });
  expect(
    parseRecap(JSON.stringify({ Goal: "Filtering threads", Review: review }))
      .summary,
  ).toBe(`Goal: Filtering threads\nReview: ${review}`);
});

it("requests a grounded acceptance check for the fixed review state", () => {
  const prompt = recapPrompt({
    transcript: "Implemented top-level filtering",
    previousRecap: null,
    state: "review",
    needsYou: null,
  });
  expect(prompt).toContain("State: review");
  expect(prompt).toContain("include exactly one Review line");
  expect(prompt).toContain("what result to expect");
  expect(prompt).toContain("For other states, omit Review");
});

it("rejects text that is not a ledger", () => {
  expect(parseRecapLedger("Just a sentence.")).toBeNull();
});

it("capitalizes items that start in lowercase", () => {
  expect(
    parseRecapLedger(
      "Goal: refining X.\nLatest: `npm test` passes\nOpen: merge it",
    ),
  ).toEqual({
    goal: "Refining X.",
    latest: ["`npm test` passes"],
    review: [],
    open: ["Merge it"],
    done: [],
  });
});

it("normalizes a JSON recap into ledger lines", () => {
  const raw = JSON.stringify({
    Goal: "Testing the user interface.",
    Latest: "The recap card renders.",
    Done: ["Added the recap card."],
  });
  expect(parseRecap(raw).summary).toBe(
    "Goal: Testing the user interface\nLatest: The recap card renders\nDone: Added the recap card",
  );
  expect(parseRecapLedger(raw)).toEqual({
    goal: "Testing the user interface.",
    latest: ["The recap card renders."],
    review: [],
    open: [],
    done: ["Added the recap card."],
  });
});
