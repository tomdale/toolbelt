import { describe, expect, it } from "vitest";
import {
  assignPrompt,
  mapPrompt,
  parseAssignments,
  parseMapProposal,
} from "../../src/domain/organize.ts";

describe("parseMapProposal", () => {
  it("keeps only changes that name real workstreams", () => {
    const result = parseMapProposal(
      JSON.stringify({
        descriptions: { alpha: "Alpha work.", Ghost: "Nope." },
        changes: [
          { kind: "rename", workstream: "alpha", name: "Alpha Prime" },
          { kind: "rename", workstream: "Ghost", name: "Real" },
          { kind: "rename", workstream: "Alpha", name: "Beta" },
          { kind: "merge", workstream: "Beta", into: "Alpha" },
          { kind: "merge", workstream: "Beta", into: "Beta" },
          { kind: "create", name: "Gamma", description: "New." },
          { kind: "create", name: "alpha" },
          { kind: "delete", workstream: "Alpha" },
        ],
      }),
      ["Alpha", "Beta"],
    );
    expect(result.descriptions).toEqual({ Alpha: "Alpha work." });
    expect(result.changes.map((c) => c.kind)).toEqual([
      "rename",
      "merge",
      "create",
    ]);
    expect(result.changes[0]).toMatchObject({
      workstream: "Alpha",
      name: "Alpha Prime",
    });
  });
});

describe("parseAssignments", () => {
  it("returns every thread once, from the closed set, and never guesses", () => {
    const result = parseAssignments(
      "```json\n" +
        JSON.stringify({
          items: [
            { id: "t1", workstream: "alpha", confidence: "high" },
            { id: "t2", workstream: "new: Gamma", confidence: "medium" },
            { id: "t3", workstream: "Nonexistent", confidence: "high" },
            { id: "t1", workstream: "Beta", confidence: "high" },
            { id: "intruder", workstream: "Alpha", confidence: "high" },
            { id: "t5", workstream: "new: beta", confidence: "high" },
          ],
        }) +
        "\n```",
      ["t1", "t2", "t3", "t4", "t5"],
      ["Alpha", "Beta"],
    );
    expect(result.map((a) => [a.id, a.target])).toEqual([
      ["t1", { kind: "existing", name: "Alpha" }],
      ["t2", { kind: "new", name: "Gamma" }],
      ["t3", { kind: "unsure" }],
      ["t4", { kind: "unsure" }],
      ["t5", { kind: "existing", name: "Beta" }],
    ]);
  });
});

describe("prompts", () => {
  it("carry titles and subjects, redacted, and no project names", () => {
    const secret = `ghp_${"z".repeat(30)}`;
    const map = mapPrompt({
      workstreams: [
        {
          name: "Alpha",
          description: null,
          roots: [{ title: `Rotate ${secret}`, subject: "Alpha" }],
        },
      ],
      unfiled: [{ title: "Loose", subject: null }],
    });
    expect(map).toContain('## "Alpha"');
    expect(map).not.toContain(secret);
    const assign = assignPrompt({
      workstreams: [{ name: "Alpha", description: "A" }],
      threads: [{ id: "t1", title: "Fix", subject: "Alpha", recap: "Done" }],
    });
    expect(assign).toContain('id "t1": Fix [Alpha] — Done');
  });
});
