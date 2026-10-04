import { describe, expect, it } from "vitest";
import {
  classifyPrompt,
  parseClassification,
  type Entity,
} from "../../src/domain/classify.ts";
import {
  activeHome,
  deriveActiveEntityIds,
  isGroupingValid,
  parseRegroup,
  regroupPrompt,
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
  it("classifies specific identities without supplying active map or threads", () => {
    const input = { prompt: "Lantern shelves", entities };
    expect(classifyPrompt(input)).not.toContain("activeEntityIds");
    expect(
      parseClassification('{"subjectId":"f","proposed":null}', input).subjectId,
    ).toBe("f");
    expect(
      parseClassification(
        '{"subjectId":null,"proposed":{"name":"Bookings","description":"Reservations","parentId":"p","ancestors":null}}',
        input,
      ).proposed?.ancestors,
    ).toBeNull();
    expect(
      parseClassification(
        '{"subjectId":null,"proposed":{"name":"Bookings","description":null,"parentId":null,"ancestors":null}}',
        input,
      ).proposed?.description,
    ).toBe("");
    expect(
      parseClassification(
        '{"subjectId":null,"proposed":{"name":"Bookings","description":"Reservations","parentId":"p"}}',
        input,
      ).proposed?.ancestors,
    ).toBeUndefined();
    expect(
      parseClassification(
        '{"subjectId":null,"proposed":{"name":"Bookings","description":"Reservations","parentId":"p","ancestors":[]}}',
        input,
      ).proposed?.ancestors,
    ).toEqual([]);
    expect(() =>
      parseClassification('{"subjectId":"invented","proposed":null}', input),
    ).toThrow();
    expect(activeHome("f", ["p"], entities)).toBe("p");
    expect(activeHome("f", ["p", "f"], entities)).toBe("f");
  });
  it("validates exact loads, contractions and indivisible overflow", () => {
    const input = {
      entities,
      counts: { p: 3, f: 4 },
      active: ["p"],
      capacity: 6,
      collapseAt: 3,
    };
    expect(() => parseRegroup('{"activeEntityIds":["p"]}', input)).toThrow(
      "capacity",
    );
    expect(
      parseRegroup('{"activeEntityIds":["p","f"]}', input).activeEntityIds,
    ).toEqual(["p", "f"]);
    expect(() =>
      parseRegroup('{"activeEntityIds":["f"]}', { ...input, counts: { f: 2 } }),
    ).toThrow("contract");
    expect(
      parseRegroup('{"activeEntityIds":["f"]}', { ...input, counts: { f: 8 } })
        .activeEntityIds,
    ).toEqual(["f"]);
    expect(() =>
      parseRegroup('{"activeEntityIds":["p","f"]}', {
        ...input,
        counts: { f: 8 },
      }),
    ).toThrow("empty");
    expect(regroupPrompt(input)).not.toContain("threadId");
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
    expect(
      parseRegroup(JSON.stringify({ activeEntityIds: split }), {
        entities,
        counts: { p: 3, f: 4 },
        active: ["p"],
        capacity: 6,
        collapseAt: 3,
      }).activeEntityIds.sort(),
    ).toEqual(["f", "p"]);

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
  });
});
