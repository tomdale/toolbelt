import { expect, it } from "vitest";
import {
  classificationPrompt,
  groupThreads,
  threadSchema,
  type Snapshot,
} from "../model";

it("includes project fallback evidence in classification prompts", () => {
  const prompt = classificationPrompt([
    {
      id: "1",
      title: "Continue work",
      project: "Agent Toolkit",
      repository: null,
      path: null,
      excerpts: "User: Continue. Assistant: What next?",
      timeline: "",
      status: "idle",
      updatedAt: 1,
      latestAttentionAt: 1,
      sectionId: null,
      hasPendingInteraction: false,
    },
  ]);
  expect(prompt).toContain('"project":"Agent Toolkit"');
  expect(prompt).toContain("then BB project name");
});

it("keeps tomdaleOS-root threads in the active product inventory", () => {
  const thread = threadSchema.parse({
    id: "operations",
    title: "tomdaleOS operations",
    project: "tomdaleOS",
    repository: null,
    status: "idle",
    updatedAt: 1,
    latestAttentionAt: 1,
    sectionId: null,
    parentThreadId: null,
    environmentPath: "/Users/tomdale/Code/tomdaleOS",
    hasPendingInteraction: false,
  });
  const groups = groupThreads({
    threads: [thread],
    analysis: null,
  } as Snapshot);
  expect(
    groups.flatMap(([, rows]) => rows.map((row) => row.thread.id)),
  ).toEqual(["operations"]);
});
