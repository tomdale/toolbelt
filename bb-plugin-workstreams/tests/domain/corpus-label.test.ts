import { expect, it } from "vitest";
import { corpusLabel } from "../../src/domain/corpus-label.ts";
it("distinguishes repeated feature names under different component scopes", () => {
  const entities = [
    { id: "p", name: "Lantern", parentId: null, description: "", aliases: [] },
    { id: "a", name: "Archive", parentId: "p", description: "", aliases: [] },
    { id: "b", name: "Sharing", parentId: "p", description: "", aliases: [] },
    { id: "x", name: "Settings", parentId: "a", description: "", aliases: [] },
    { id: "y", name: "Settings", parentId: "b", description: "", aliases: [] },
  ];
  expect(corpusLabel("x", entities)).toBe("Lantern: Archive: Settings");
  expect(corpusLabel("y", entities)).toBe("Lantern: Sharing: Settings");
});
