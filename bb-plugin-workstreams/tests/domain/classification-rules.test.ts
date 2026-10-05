import { expect, it } from "vitest";
import { cases } from "../../eval/classification-cases.ts";
import {
  fullAnalysisPrompt,
  parseFullAnalysis,
  type FullAnalysisInput,
} from "../../src/domain/analysis.ts";
import { parseTopic, topicFieldsSchema } from "../../src/domain/classify.ts";

it("renders the synthetic ownership fixtures in Full analysis and parses their expected topics", () => {
  expect(cases).toHaveLength(16);
  for (const c of cases) {
    const input: FullAnalysisInput = {
      title: c.input.prompt,
      requests: (c.input.requests ?? []).map((text, i) => ({
        text,
        initial: i === 0,
      })),
      lastAssistantText: c.input.prompt,
      report: { state: "complete", headline: "Done", latest: [] },
      mode: "full",
      topic: { entities: c.input.entities, project: null, current: null },
    };
    const prompt = fullAnalysisPrompt(input);
    expect(prompt).toContain(c.input.requests![0]);
    expect(prompt).toContain("User requests and explicit diagnoses");
    expect(prompt).toContain(
      "Shared platform capabilities and contracts belong to the platform",
    );
    expect(prompt).toContain(
      "Triggering or consuming another capability, or targeting an object, does not establish parentage",
    );
    expect(
      parseFullAnalysis(
        JSON.stringify({ goal: "Goal", subjectId: c.expected, proposed: null }),
        input,
      ).topic?.subjectId ?? null,
    ).toBe(c.expected);
  }
});

it("parses a topic answer that omits the unused field", () => {
  const entities = [
    {
      id: "alerts",
      name: "Alert Investigations",
      description: null,
      parentId: null,
      aliases: [],
    },
  ];
  const parse = (text: string) =>
    parseTopic(topicFieldsSchema.parse(JSON.parse(text)), entities);
  expect(parse('{"subjectId":"alerts"}').subjectId).toBe("alerts");
  const proposal = parse('{"proposed":{"name":"Recap Cards","description":""}}');
  expect(proposal.subjectId).toBeNull();
  expect(proposal.proposed?.name).toBe("Recap Cards");
  expect(() => parse('{"subjectId":"invented"}')).toThrow();
});
