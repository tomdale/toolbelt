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
    expect(prompt).toContain("entire collection together");
    expect(prompt).toContain("untrusted evidence");
  });
  it("accepts a complete closed assignment with Unsorted", () =>
    expect(parseOrganization(JSON.stringify(valid()), input)).toEqual(valid()));
  it.each([
    "missing",
    "duplicate",
    "unknown",
    "target",
    "section",
    "empty",
    "duplicateName",
  ])("rejects %s rather than partly applying", (mode) => {
    const result = valid();
    if (mode === "missing") result.assignments.pop();
    if (mode === "duplicate") result.assignments[1]!.threadId = "t1";
    if (mode === "unknown") result.assignments[1]!.threadId = "invented";
    if (mode === "target") result.assignments[0]!.workstream = "invented";
    if (mode === "section") result.workstreams[0]!.sectionId = "invented";
    if (mode === "empty") result.assignments[0]!.workstream = null as never;
    if (mode === "duplicateName")
      result.workstreams.push({ ...result.workstreams[0]!, key: "other" });
    expect(() => parseOrganization(JSON.stringify(result), input)).toThrow();
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
