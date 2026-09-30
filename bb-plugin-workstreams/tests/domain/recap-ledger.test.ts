import { expect, it } from "vitest";
import { parseRecap, parseRecapLedger } from "../../src/domain/recap.ts";

it("parses one labeled line per item", () => {
  expect(parseRecapLedger("Goal: Building X.\nLatest: A\nLatest: B\nOpen: C")).toEqual({
    goal: "Building X.", latest: ["A", "B"], open: ["C"], done: [],
  });
});

it("parses headings followed by item lines", () => {
  expect(parseRecapLedger("Goal: Building X.\nLatest:\nA\n- B\nDone:\nD")).toEqual({
    goal: "Building X.", latest: ["A", "B"], open: [], done: ["D"],
  });
});

it("rejects text that is not a ledger", () => {
  expect(parseRecapLedger("Just a sentence.")).toBeNull();
});

it("capitalizes items that start in lowercase", () => {
  expect(parseRecapLedger("Goal: refining X.\nLatest: `npm test` passes\nOpen: merge it")).toEqual({
    goal: "Refining X.", latest: ["`npm test` passes"], open: ["Merge it"], done: [],
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
    open: [],
    done: ["Added the recap card."],
  });
});
