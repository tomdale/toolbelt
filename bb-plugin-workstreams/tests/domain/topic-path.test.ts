import { expect, it } from "vitest";
import { topicPath } from "../../src/domain/topic-path.ts";
it("distinguishes repeated feature names under different component scopes", () => {
  const entities = [
    { id: "p", name: "Lantern", parentId: null, description: "", aliases: [] },
    { id: "a", name: "Archive", parentId: "p", description: "", aliases: [] },
    { id: "b", name: "Sharing", parentId: "p", description: "", aliases: [] },
    { id: "x", name: "Settings", parentId: "a", description: "", aliases: [] },
    { id: "y", name: "Settings", parentId: "b", description: "", aliases: [] },
  ];
  expect(topicPath("x", entities)).toBe("Lantern: Archive: Settings");
  expect(topicPath("y", entities)).toBe("Lantern: Sharing: Settings");
});
