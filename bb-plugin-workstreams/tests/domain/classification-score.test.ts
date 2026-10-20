import { expect, it } from "vitest";
import { scoreClassification } from "../../eval/classification-score.ts";
import { cases } from "../../eval/classification-cases.ts";
it("accepts capability synonyms while rejecting flattened required ancestry", () => {
  const c = cases.find((c) => c.id === "waiting-schema")!;
  const score = (names: string[]) =>
    scoreClassification(
      {
        subjectId: null,
        proposed: {
          name: names.at(-1)!,
          description: "",
          parentId: null,
          ancestors: names
            .slice(0, -1)
            .map((name) => ({ name, description: "" })),
        },
      },
      c.input,
      c.expected,
      true,
    );
  expect(score(["Loom", "Summaries", "Waiting state"]).pass).toBe(true);
  expect(score(["Loom", "Waiting Recap"]).owner).toBe(true);
  expect(score(["Loom", "Waiting Recap"]).hierarchy).toBe(false);
});
it("rejects a familiar title's wrong capability despite a correct owner", () => {
  const c = cases.find((c) => c.id === "misleading-title")!;
  const result = scoreClassification(
    {
      subjectId: null,
      proposed: {
        name: "Recaps",
        description: "",
        parentId: null,
        ancestors: [{ name: "Loom", description: "" }],
      },
    },
    c.input,
    c.expected,
    true,
  );
  expect(result.owner).toBe(true);
  expect(result.capability).toBe(false);
  expect(result.pass).toBe(false);
});

it("expects a new topic outside the app whose pane only looks like the answer", () => {
  const c = cases.find((c) => c.id === "lookalike-missing")!;
  const score = (value: Parameters<typeof scoreClassification>[0]) =>
    scoreClassification(value, c.input, c.expected, false, c.expectNew).pass;
  const proposal = (parentId: string | null, ...ancestors: string[]) => ({
    subjectId: null,
    proposed: {
      name: "Guide plugin",
      description: "",
      parentId,
      ancestors: ancestors.map((name) => ({ name, description: "" })),
    },
  });
  // The pane fits the words, but belongs to another product.
  expect(score({ subjectId: "pane", proposed: null })).toBe(false);
  expect(score({ subjectId: "app", proposed: null })).toBe(false);
  expect(score({ subjectId: null, proposed: null })).toBe(false);
  // New topics under the app, however the proposal spells its ancestry.
  expect(score(proposal("app"))).toBe(false);
  expect(score(proposal(null, "Pennant"))).toBe(false);
  expect(score(proposal("pane"))).toBe(false);
  // New topics under the platform, or as a root of their own.
  expect(score(proposal("platform"))).toBe(true);
  expect(score(proposal(null, "Harbor"))).toBe(true);
  expect(score(proposal(null))).toBe(true);
});

it("expects the platform's own plugin topic when it exists beside the lookalike", () => {
  const c = cases.find((c) => c.id === "lookalike-present")!;
  expect(c.expected).toBe("plugin");
  const score = (subjectId: string) =>
    scoreClassification(
      { subjectId, proposed: null },
      c.input,
      c.expected,
      false,
      c.expectNew,
    ).pass;
  expect(score("plugin")).toBe(true);
  expect(score("pane")).toBe(false);
  // Both trees hold the lookalike under another product, and only warm runs use them.
  for (const id of ["lookalike-missing", "lookalike-present"]) {
    const tree = cases.find((c) => c.id === id)!;
    expect(tree.warmOnly).toBe(true);
    expect(tree.input.entities.find((e) => e.id === "pane")?.parentId).toBe(
      "app",
    );
  }
});
