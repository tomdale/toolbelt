import { expect, it } from "vitest";
import { compareGroupNames } from "../../src/domain/group-name-order.ts";
it("orders complete lists lexically without mutation or natural numeric sorting", () => {
  const names = ["Zulu", "beta", "Alpha", "Feature 2", "Feature 10"];
  expect([...names].sort(compareGroupNames)).toEqual([
    "Alpha",
    "beta",
    "Feature 10",
    "Feature 2",
    "Zulu",
  ]);
  expect(names[0]).toBe("Zulu");
});
