import { expect, it } from "vitest";
import { cases } from "../../eval/classification-cases.ts";
import {
  classifyPrompt,
  parseClassification,
} from "../../src/domain/classify.ts";
it("renders synthetic ownership fixtures and parses their expected existing IDs", () => {
  expect(cases).toHaveLength(13);
  for (const c of cases) {
    const prompt = classifyPrompt(c.input);
    expect(prompt).toContain(c.input.requests![0]);
    expect(prompt).toContain("User requests and explicit diagnoses");
    expect(prompt).toContain(
      "Shared platform capabilities belong to the platform",
    );
    expect(prompt).toContain(
      "Triggering or consuming a capability does not establish parentage",
    );
    expect(prompt).not.toContain('"entities":');
    expect(
      parseClassification(
        JSON.stringify({ subjectId: c.expected, proposed: null }),
        c.input,
      ).subjectId,
    ).toBe(c.expected);
  }
});

it("parses a subject match that omits the unused proposal fields", () => {
  const input = {
    prompt: "Fix the alert investigation flow",
    entities: [
      {
        id: "alerts",
        name: "Alert Investigations",
        description: null,
        parentId: null,
        aliases: [],
      },
    ],
  };
  // The model returns only the field it chose; an absent `proposed` is a
  // subject match, and an absent `subjectId` is a proposal.
  expect(
    parseClassification('{"subjectId":"alerts"}', input).subjectId,
  ).toBe("alerts");
  const proposal = parseClassification(
    '{"proposed":{"name":"Recap Cards","description":""}}',
    input,
  );
  expect(proposal.subjectId).toBeUndefined();
  expect(proposal.proposed?.name).toBe("Recap Cards");
});
