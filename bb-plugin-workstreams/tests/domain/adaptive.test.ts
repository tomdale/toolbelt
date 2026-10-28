import { describe, expect, it } from "vitest";
import type { Entity } from "../../src/domain/classify.ts";
import { activeHome, deriveActiveEntityIds } from "../../src/domain/regroup.ts";

const entities: Entity[] = [
  { id: "p", name: "Lantern", description: "", parentId: null, aliases: [] },
  { id: "f", name: "Shelves", description: "", parentId: "p", aliases: [] },
  { id: "leaf", name: "Sync", description: "", parentId: "f", aliases: [] },
  { id: "g", name: "Sharing", description: "", parentId: "p", aliases: [] },
  { id: "q", name: "Quarry", description: "", parentId: null, aliases: [] },
  { id: "qa", name: "Auth", description: "", parentId: "q", aliases: [] },
];
const derive = (counts: Record<string, number>, collapseAt = 3) =>
  deriveActiveEntityIds({ entities, counts, collapseAt }).sort();

describe("deriveActiveEntityIds", () => {
  it("gives a small product one workstream for all its topics", () => {
    expect(derive({ f: 1, leaf: 1, g: 1 })).toEqual(["p"]);
    expect(derive({ leaf: 3 })).toEqual(["p"]);
  });

  it("gives a larger product a workstream for every topic with threads", () => {
    expect(derive({ p: 1, leaf: 1, g: 2 })).toEqual(["g", "leaf", "p"]);
    expect(derive({ f: 2, leaf: 1, g: 1 })).toEqual(["f", "g", "leaf"]);
    // One topic holding everything is one workstream.
    expect(derive({ g: 9 })).toEqual(["g"]);
  });

  it("decides each product separately", () => {
    expect(derive({ f: 2, g: 2, qa: 1 })).toEqual(["f", "g", "q"]);
  });

  it("leaves products and topics with no visible roots out", () => {
    expect(derive({ f: 0, g: 0 })).toEqual([]);
    expect(derive({ f: 4, g: 0 })).toEqual(["f"]);
  });

  it("splits every product with threads when the threshold is zero", () => {
    expect(derive({ leaf: 1, qa: 1 }, 0)).toEqual(["leaf", "qa"]);
  });

  it("homes a topic at its nearest active ancestor", () => {
    expect(activeHome("leaf", ["p"], entities)).toBe("p");
    expect(activeHome("leaf", ["p", "f"], entities)).toBe("f");
    expect(activeHome("leaf", ["g"], entities)).toBeNull();
  });
});
