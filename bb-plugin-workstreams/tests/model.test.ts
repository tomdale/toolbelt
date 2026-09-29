import { expect, it } from "vitest";
import {
  classificationPrompt,
  cleanDerivedAnalysis,
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

it("clears stale Dispatch wording from derived analysis without changing history", () => {
  const analysis = cleanDerivedAnalysis({
    at: 1,
    needsYouCount: 0,
    items: [
      {
        threadId: "stale",
        group: "Dispatch",
        recap: "Dispatch cleanup is done.",
        title: "Review Dispatch hierarchy",
        needsYou: false,
        state: "done",
        archiveReason: null,
        drift: null,
        updatedAt: 1,
        refreshed: true,
      },
      {
        threadId: "unrelated",
        group: "BB",
        recap: "Updated the plugin UI.",
        title: "Update plugin UI",
        needsYou: false,
        state: "in_progress",
        archiveReason: null,
        drift: null,
        updatedAt: 1,
        refreshed: true,
      },
    ],
    warnings: ["Dispatch could not be refreshed."],
    summaries: {
      Dispatch: {
        about: "Dispatch operations",
        status: "Dispatch cleanup complete",
        motif: "arrows",
        needsYou: 0,
      },
      BB: {
        about: "BB plugin",
        status: "UI work",
        motif: "tools",
        needsYou: 0,
      },
    },
  });
  expect(analysis?.items[0]).toMatchObject({
    group: "Unclassified",
    recap: "Review the latest thread activity for current status.",
  });
  expect(analysis?.items[0].title).toBeUndefined();
  expect(analysis?.items[1].recap).toBe("Updated the plugin UI.");
  expect(Object.keys(analysis?.summaries ?? {})).toEqual(["BB"]);
  expect(analysis?.warnings).toEqual([]);
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
