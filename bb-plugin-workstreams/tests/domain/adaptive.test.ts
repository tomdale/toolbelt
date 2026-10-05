import { describe, expect, it } from "vitest";
import type { Entity } from "../../src/domain/classify.ts";
import {
  activeHome,
  deriveActiveEntityIds,
  isGroupingValid,
} from "../../src/domain/regroup.ts";
const entities: Entity[] = [
  {
    id: "p",
    name: "Lantern",
    description: "Product",
    parentId: null,
    aliases: [],
  },
  {
    id: "f",
    name: "Shared shelves",
    description: "Feature",
    parentId: "p",
    aliases: ["Shelves"],
  },
];
describe("separated classification and grouping", () => {
  it("homes a topic at its nearest active ancestor", () => {
    expect(activeHome("f", ["p"], entities)).toBe("p");
    expect(activeHome("f", ["p", "f"], entities)).toBe("f");
  });
  it("validates exact loads, contractions and indivisible overflow", () => {
    const valid = (ids: string[], counts: Record<string, number>) =>
      isGroupingValid(ids, entities, counts, 6, 3);
    expect(valid(["p"], { p: 3, f: 4 })).toBe(false);
    expect(valid(["p", "f"], { p: 3, f: 4 })).toBe(true);
    expect(valid(["f"], { f: 2 })).toBe(false);
    expect(valid(["f"], { f: 8 })).toBe(true);
    expect(valid(["p", "f"], { f: 8 })).toBe(false);
  });

  it("deterministically derives active groups enforcing capacity, contraction, and stability", () => {
    // Sparse count contracts to product root
    const sparse = deriveActiveEntityIds({
      entities,
      counts: { f: 2 },
      active: ["f"],
      capacity: 6,
      collapseAt: 3,
    });
    expect(sparse).toEqual(["p"]);

    // Exceeding capacity extracts feature cluster
    const split = deriveActiveEntityIds({
      entities,
      counts: { p: 3, f: 4 },
      active: ["p"],
      capacity: 6,
      collapseAt: 3,
    });
    expect(split.sort()).toEqual(["f", "p"]);
    expect(isGroupingValid(split, entities, { p: 3, f: 4 }, 6, 3)).toBe(true);

    // Indivisible overflow keeps single overflow group and drops empty root
    const overflow = deriveActiveEntityIds({
      entities,
      counts: { f: 8 },
      active: ["p"],
      capacity: 6,
      collapseAt: 3,
    });
    expect(overflow).toEqual(["f"]);

    // Stability: preserves valid active groups when load is within capacity
    const stable = deriveActiveEntityIds({
      entities,
      counts: { p: 2, f: 3 },
      active: ["f", "p"],
      capacity: 6,
      collapseAt: 3,
    });
    expect(stable.sort()).toEqual(["f", "p"]);

    // Empty product with visible retention returns product root
    const retained = deriveActiveEntityIds({
      entities,
      counts: {},
      active: [],
      capacity: 6,
      collapseAt: 3,
      visibleProductRoots: ["p"],
    });
    expect(retained).toEqual(["p"]);

    // Completely empty product without retention returns no groups
    const empty = deriveActiveEntityIds({
      entities,
      counts: {},
      active: [],
      capacity: 6,
      collapseAt: 3,
    });
    expect(empty).toEqual([]);

    // Multi-product workspaces: does not throw Unknown corpus identity when counts span products
    const multiEntities: Entity[] = [
      { id: "p1", name: "Product 1", description: "", parentId: null, aliases: [] },
      { id: "f1", name: "Feature 1", description: "", parentId: "p1", aliases: [] },
      { id: "p2", name: "Product 2", description: "", parentId: null, aliases: [] },
      { id: "f2", name: "Feature 2", description: "", parentId: "p2", aliases: [] },
    ];
    const multi = deriveActiveEntityIds({
      entities: multiEntities,
      counts: { f1: 4, f2: 4 },
      active: [],
      capacity: 6,
      collapseAt: 3,
    });
    expect(multi.sort()).toEqual(["p1", "p2"]);

    // Completed retention on sibling expansion: product root retained when visibleProductRoots specified
    const retainedOnExpansion = deriveActiveEntityIds({
      entities,
      counts: { f: 8 },
      active: ["p"],
      capacity: 6,
      collapseAt: 3,
      visibleProductRoots: ["p"],
    });
    expect(retainedOnExpansion.sort()).toEqual(["f", "p"]);
  });
});
