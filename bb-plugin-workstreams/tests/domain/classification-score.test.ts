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
