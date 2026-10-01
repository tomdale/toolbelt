import { describe, it, expect } from "vitest";
import {
  organizePrompt,
  parseOrganization,
  type OrganizeInput,
} from "../../src/domain/organize.ts";
const input: OrganizeInput = {
  workstreams: [
    { id: "s1", name: "Product", description: "Product work", aliases: [] },
  ],
  threads: [
    {
      id: "t1",
      title: "Build product",
      recap: "Implementing it",
      project: "Repo",
      sectionId: "s1",
      children: ["Review"],
    },
    {
      id: "t2",
      title: "Unrelated",
      recap: null,
      project: null,
      sectionId: null,
      children: [],
    },
  ],
};
const valid = () => ({
  workstreams: [
    {
      key: "w",
      sectionId: "s1",
      name: "Product",
      description: "Build and maintain the product",
      aliases: ["P"],
    },
  ],
  assignments: [
    { threadId: "t1", workstream: "w", reason: "Product task" },
    { threadId: "t2", workstream: null, reason: "Unrelated" },
  ],
});
describe("whole-map organization", () => {
  it("includes all roots and bounded evidence in one prompt", () => {
    const prompt = organizePrompt(input);
    expect(prompt).toContain('"id":"t1"');
    expect(prompt).toContain('"id":"t2"');
    expect(prompt).toContain("Review");
    expect(prompt).toContain("Count the roots per owner");
    expect(prompt).toContain("untrusted evidence");
  });
  it("accepts a complete closed assignment with Unfiled", () =>
    expect(parseOrganization(JSON.stringify(valid()), input)).toEqual(valid()));
  it.each([
    "missing",
    "duplicate",
    "unknown",
    "target",
    "section",
    "duplicateName",
  ])("rejects %s rather than partly applying", (mode) => {
    const result = valid();
    if (mode === "missing") result.assignments.pop();
    if (mode === "duplicate") result.assignments[1]!.threadId = "t1";
    if (mode === "unknown") result.assignments[1]!.threadId = "invented";
    if (mode === "target") result.assignments[0]!.workstream = "invented";
    if (mode === "section") {
      result.workstreams[0]!.sectionId = "invented";
      result.workstreams[0]!.name = "Unknown effort";
    }
    if (mode === "duplicateName")
      result.workstreams.push({ ...result.workstreams[0]!, key: "other" });
    expect(() => parseOrganization(JSON.stringify(result), input)).toThrow();
  });
  it("reuses an exact named home even if the model chose another section ID", () => {
    const result = valid();
    result.workstreams[0]!.sectionId = "wrong-id";
    expect(
      parseOrganization(JSON.stringify(result), input).workstreams[0]!
        .sectionId,
    ).toBe("s1");
  });
  it("accepts a null owner for an Unfiled root", () => {
    const result = valid();
    (result.assignments[1] as Record<string, unknown>).owner = null;
    expect(() =>
      parseOrganization(JSON.stringify(result), input),
    ).not.toThrow();
  });
  it("drops unused model-proposed homes without changing assignments", () => {
    const result = valid();
    result.assignments[0]!.workstream = null as never;
    const parsed = parseOrganization(JSON.stringify(result), input);
    expect(parsed.workstreams).toEqual([]);
    expect(parsed.assignments).toEqual(result.assignments);
  });
  it("prefers concrete product ownership over abstract feature topics and specifies colon-prefixed sub-areas", () => {
    const prompt = organizePrompt(input);
    expect(prompt).toContain("concrete product or project");
    expect(prompt).toContain("MUST be split into 2–3 areas");
    expect(prompt).toContain('"<Owner>: <Area>"');
    expect(prompt).toContain("never technical layers");
  });
  it("fails explicitly rather than truncating large inventories", () =>
    expect(() =>
      organizePrompt({ ...input, threads: Array(501).fill(input.threads[0]) }),
    ).toThrow("500"));
  it("bounds individual source text", () =>
    expect(
      organizePrompt({
        ...input,
        threads: [{ ...input.threads[0]!, recap: "x".repeat(10000) }],
      }),
    ).not.toContain("x".repeat(401)));
});
