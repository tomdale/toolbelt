import { describe, expect, it } from "vitest";
import {
  mergePresence,
  type PresenceEntry,
} from "../../src/app/sidebar/motion.ts";

const id = (s: string) => s;
const view = (entries: PresenceEntry<string>[]) =>
  entries.map((e) => `${e.key}:${e.phase}`);

describe("mergePresence", () => {
  it("keeps a leaving item in its place and enters new ones", () => {
    const first = mergePresence([], ["a", "b", "c"], id, true);
    expect(view(first)).toEqual(["a:enter", "b:enter", "c:enter"]);
    const settled = first.map((e) => ({ ...e, phase: "idle" as const }));
    expect(view(mergePresence(settled, ["n", "a", "c"], id, true))).toEqual([
      "n:enter",
      "a:idle",
      "b:leave",
      "c:idle",
    ]);
  });

  it("puts a leaver first when nothing before it remains", () => {
    const before = ["a", "b"].map((key) => ({
      key,
      item: key,
      phase: "idle" as const,
    }));
    expect(view(mergePresence(before, ["b"], id, true))).toEqual([
      "a:leave",
      "b:idle",
    ]);
  });

  it("re-enters an item that returns while leaving", () => {
    const before = [{ key: "a", item: "a", phase: "leave" as const }];
    expect(view(mergePresence(before, ["a"], id, true))).toEqual(["a:enter"]);
  });

  it("is the list exactly without motion", () => {
    const before = [{ key: "a", item: "a", phase: "idle" as const }];
    expect(view(mergePresence(before, ["b"], id, false))).toEqual(["b:idle"]);
  });
});
