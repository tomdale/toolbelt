import { describe, expect, it } from "vitest";
import { buildForest, flatten } from "../../src/domain/tree.ts";
import { rng, thread } from "./fixtures.ts";

const ids = (forest: ReturnType<typeof buildForest>) =>
  forest.roots.flatMap((root) => flatten(root).map((n) => n.thread.id));

describe("buildForest", () => {
  it("nests children under parents at any depth", () => {
    const forest = buildForest([
      thread("a"),
      thread("b", { parentThreadId: "a" }),
      thread("c", { parentThreadId: "b" }),
      thread("d", { parentThreadId: "c" }),
    ]);
    expect(forest.roots).toHaveLength(1);
    const rows = flatten(forest.roots[0]!);
    expect(rows.map((r) => [r.thread.id, r.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 3],
    ]);
    expect(forest.rootOf.get("d")?.id).toBe("a");
  });

  it("promotes threads with missing parents to roots and reports them", () => {
    const forest = buildForest([
      thread("child", { parentThreadId: "archived-parent" }),
      thread("root"),
    ]);
    expect(forest.roots.map((r) => r.thread.id).sort()).toEqual([
      "child",
      "root",
    ]);
    expect(forest.orphanIds).toEqual(["child"]);
  });

  it("breaks cycles deterministically at the lowest id", () => {
    const forest = buildForest([
      thread("y", { parentThreadId: "x" }),
      thread("x", { parentThreadId: "z" }),
      thread("z", { parentThreadId: "y" }),
    ]);
    expect(forest.roots.map((r) => r.thread.id)).toEqual(["x"]);
    expect(ids(forest)).toEqual(["x", "y", "z"]);
    expect([...forest.cycleIds].sort()).toEqual(["x", "y", "z"]);
  });

  it("treats a self-parented thread as a root", () => {
    const forest = buildForest([thread("s", { parentThreadId: "s" })]);
    expect(ids(forest)).toEqual(["s"]);
  });

  it("places every thread exactly once in generated forests", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = rng(seed);
      const count = 1 + Math.floor(random() * 40);
      const threads = Array.from({ length: count }, (_, i) => {
        const roll = random();
        const parentThreadId =
          roll < 0.3
            ? null
            : roll < 0.4
              ? `missing-${i}`
              : `t${Math.floor(random() * count)}`;
        return thread(`t${i}`, { parentThreadId });
      });
      const placed = ids(buildForest(threads));
      expect(placed.length).toBe(count);
      expect(new Set(placed).size).toBe(count);
    }
  });
});
