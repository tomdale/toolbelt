import { expect, it } from "vitest";
import { classificationEvidence } from "../../src/domain/classify.ts";
it("uses local names and indentation without empty JSON fields", () => {
  expect(
    classificationEvidence({
      entities: [
        {
          id: "p",
          name: "Lantern",
          description: null,
          parentId: null,
          aliases: [],
        },
        {
          id: "s",
          name: "Sidebar",
          description: "Navigation",
          parentId: "p",
          aliases: [],
        },
        {
          id: "u",
          name: "Up Next",
          description: "",
          parentId: "s",
          aliases: ["Upcoming"],
        },
      ],
      prompt: "Review using Prism\n CLI",
      requests: ["Review Lantern", "Review Lantern"],
    }),
  ).toBe(
    "## Catalog\n- Lantern [p]\n  - Sidebar [s] — Navigation\n    - Up Next [u]; aliases: Upcoming\n\n## Request\nReview using Prism CLI\n\n## User requests\n- Review Lantern",
  );
});
it("rejects ancestry that cannot be represented faithfully", () => {
  expect(() =>
    classificationEvidence({
      prompt: "x",
      entities: [
        { id: "x", name: "x", description: null, parentId: "x", aliases: [] },
      ],
    }),
  ).toThrow("ancestry");
});
