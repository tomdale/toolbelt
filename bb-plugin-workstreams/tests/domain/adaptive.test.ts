import { describe, expect, it } from "vitest";
import {
  classifyPrompt,
  parseClassification,
  type Entity,
} from "../../src/domain/classify.ts";
import {
  activeHome,
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
});
