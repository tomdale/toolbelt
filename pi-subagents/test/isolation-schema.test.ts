import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

const isolationSchema = Type.Optional(
  Type.Union([
    Type.Literal("none"),
    Type.Literal("worktree"),
  ]),
);

describe("isolation tool schema", () => {
  it("offers an explicit non-isolated value for strict tool callers", () => {
    const schema = Type.Object({ isolation: isolationSchema }) as any;

    expect(schema.required ?? []).not.toContain("isolation");
    expect(schema.properties.isolation.anyOf.map(({ const: value, type }: any) => ({ value, type }))).toEqual([
      { value: "none", type: "string" },
      { value: "worktree", type: "string" },
    ]);
  });
});
