import { expect, it } from "vitest";
import { parseRecapLedger } from "../../src/domain/recap.ts";

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
