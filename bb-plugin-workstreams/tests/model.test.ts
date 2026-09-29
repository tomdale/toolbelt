import { expect, it } from "vitest";
import {
  classificationPrompt,
  normalizeAnalysis,
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

it("normalizes persisted analysis without mutating valid groups and omits undefined fields", () => {
  const analysis = normalizeAnalysis({
    at: 1,
    needsYouCount: 0,
    items: [
      {
        threadId: "legacy",
        group: "Personal Dispatch Tools",
        recap: "Review activity.",
        title: undefined,
        needsYou: false,
        state: "in_progress",
        archiveReason: null,
        drift: null,
        updatedAt: 1,
        refreshed: true,
      },
      {
        threadId: "valid",
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
    warnings: [],
    summaries: {
      "Personal Dispatch Tools": {
        about: "Personal tools",
        status: "Active",
        motif: "tools",
        needsYou: 0,
      },
    },
  });
  expect(analysis?.items[0].group).toBe("Personal Dispatch Tools");
  expect("title" in (analysis?.items[0] ?? {})).toBe(false);
  expect(analysis?.summaries["Personal Dispatch Tools"]?.about).toBe(
    "Personal tools",
  );
  expect(analysis?.items[1].recap).toBe("Updated the plugin UI.");
  expect(() => JSON.stringify(analysis)).not.toThrow();
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
