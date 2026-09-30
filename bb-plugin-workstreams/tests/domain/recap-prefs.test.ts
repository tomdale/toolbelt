import { expect, it } from "vitest";
import { parseRecapPrefs } from "../../src/domain/recapPrefs.ts";

it("fills defaults for missing or invalid preferences", () => {
  expect(parseRecapPrefs(null)).toEqual({
    automatic: true,
    layout: "detailed",
    quietSeconds: 30,
    minTurns: 3,
  });
  expect(parseRecapPrefs({ layout: "huge", automatic: "yes" })).toMatchObject({
    automatic: true,
    layout: "detailed",
  });
});

it("clamps timing to its ranges", () => {
  expect(parseRecapPrefs({ quietSeconds: 1, minTurns: 99 })).toMatchObject({
    quietSeconds: 5,
    minTurns: 20,
  });
});
