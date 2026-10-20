import { describe, expect, it } from "vitest";
import {
  settleIdentity,
  type ThreadObjective,
} from "../../src/domain/identity.ts";
const previous: ThreadObjective = {
  summary:
    "Make the release pipeline reliable across deployment and verification",
  title: "Release pipeline reliability",
  evidenceIds: ["opening"],
};
describe("durable identity transitions", () => {
  it("keeps the overall goal even when a keep candidate contains a subtask title", () => {
    expect(
      settleIdentity({
        previous,
        candidate: {
          ...previous,
          title: "Investigate schema errors",
          change: "keep",
        },
        requestIds: ["followup"],
      }).objective,
    ).toBe(previous);
  });
  it("requires explicit supported evidence for refinements", () => {
    expect(
      settleIdentity({
        previous,
        candidate: { ...previous, change: "refine", evidenceIds: ["invented"] },
        requestIds: ["followup"],
      }).objective,
    ).toBe(previous);
    expect(
      settleIdentity({
        previous,
        candidate: {
          ...previous,
          title: "Deployment pipeline reliability",
          evidenceIds: ["followup"],
          change: "refine",
        },
        requestIds: ["followup"],
      }).objective?.title,
    ).toBe("Deployment pipeline reliability");
  });
  it("only pivots with the latest user's evidence", () => {
    const pivot = {
      summary: "Audit the billing workflow",
      title: "Billing workflow audit",
      evidenceIds: ["opening"],
      change: "pivot" as const,
    };
    expect(
      settleIdentity({
        previous,
        candidate: pivot,
        requestIds: ["opening", "pivot"],
      }).objective,
    ).toBe(previous);
    expect(
      settleIdentity({
        previous,
        candidate: { ...pivot, evidenceIds: ["pivot"] },
        requestIds: ["opening", "pivot"],
      }).objective?.title,
    ).toBe("Billing workflow audit");
  });
  it("retains identity without a valid candidate", () => {
    expect(
      settleIdentity({ previous, candidate: null, requestIds: [] }).objective,
    ).toBe(previous);
  });
});
