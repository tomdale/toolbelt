import { describe, expect, it } from "vitest";
import { nearestActive, type CorpusEntity } from "../../src/domain/corpus.ts";

const entity = (id: string, parentId: string | null = null): CorpusEntity => ({
  id,
  name: id,
  description: "",
  parentId,
  aliases: [],
});

describe("nearestActive", () => {
  it("selects the closest active ancestor and breaks duplicate placements by section id", () => {
    const entities = [
      entity("root"),
      entity("child", "root"),
      entity("leaf", "child"),
    ];
    expect(
      nearestActive(
        "leaf",
        entities,
        new Map([
          ["z-section", "root"],
          ["b-section", "child"],
          ["a-section", "child"],
        ]),
      ),
    ).toBe("a-section");
    expect(
      nearestActive("leaf", entities, new Map([["root-section", "root"]])),
    ).toBe("root-section");
  });

  it("returns null for an unknown subject or a chain without active groups", () => {
    const entities = [entity("root"), entity("child", "root")];
    expect(nearestActive("missing", entities, new Map())).toBeNull();
    expect(nearestActive("child", entities, new Map())).toBeNull();
  });
});
