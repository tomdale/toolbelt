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

it("projects differing analysis groups and sections under the root section", () => {
  const threads = [
    { id: "root", title: "Parent", project: "P", sectionId: "native" },
    {
      id: "child",
      title: "Child",
      project: "Q",
      sectionId: "other",
      parentThreadId: "root",
    },
    {
      id: "grandchild",
      title: "Grandchild",
      project: "Q",
      sectionId: null,
      parentThreadId: "child",
    },
  ].map((t) =>
    threadSchema.parse({
      repository: null,
      status: "idle",
      updatedAt: 1,
      latestAttentionAt: 1,
      hasPendingInteraction: false,
      ...t,
    }),
  );
  const groups = groupThreads(
    {
      threads,
      analysis: {
        at: 1,
        needsYouCount: 0,
        warnings: [],
        summaries: {},
        items: threads.map((t) => ({
          threadId: t.id,
          group: t.id === "root" ? "Root product" : "Other product",
          recap: "Recap",
          updatedAt: 1,
          refreshed: true,
        })),
      },
      progress: null,
      error: null,
      fixture: null,
    },
    new Map([
      ["native", "Native"],
      ["other", "Other"],
    ]),
  );
  expect(groups.map(([name]) => name)).toEqual(["Native"]);
  expect(groups[0][1].map((row) => row.thread.id)).toEqual([
    "root",
    "child",
    "grandchild",
  ]);
});

it("keeps a manager tree together even when descendants have sections", () => {
  const threads = [
    { id: "manager", title: "Alpha — manager", project: "P", sectionId: null },
    {
      id: "worker",
      title: "Worker",
      project: "P",
      sectionId: "other",
      parentThreadId: "manager",
    },
    { id: "root", title: "Separate", project: "P", sectionId: "other" },
  ].map((t) =>
    threadSchema.parse({
      repository: null,
      status: "idle",
      updatedAt: 1,
      latestAttentionAt: 1,
      hasPendingInteraction: false,
      ...t,
    }),
  );
  const groups = groupThreads(
    { threads, analysis: null } as Snapshot,
    new Map([["other", "Other"]]),
  );
  expect(
    groups.map(([name, rows]) => [name, rows.map((row) => row.thread.id)]),
  ).toEqual([
    ["Alpha", ["manager", "worker"]],
    ["Other", ["root"]],
  ]);
});

it("retains orphan and cyclic rows exactly once with deterministic ownership", () => {
  const threads = [
    { id: "orphan", parentThreadId: "gone" },
    { id: "cycle-b", parentThreadId: "cycle-a" },
    { id: "cycle-a", parentThreadId: "cycle-b" },
    { id: "branch", parentThreadId: "cycle-b" },
  ].map((t) =>
    threadSchema.parse({
      title: t.id,
      project: "P",
      sectionId: null,
      repository: null,
      status: "idle",
      updatedAt: 1,
      latestAttentionAt: 1,
      hasPendingInteraction: false,
      ...t,
    }),
  );
  const groups = groupThreads({ threads, analysis: null } as Snapshot);
  const ids = groups.flatMap(([, rows]) => rows.map((row) => row.thread.id));
  expect(ids.sort()).toEqual(threads.map((thread) => thread.id).sort());
  expect(new Set(ids).size).toBe(threads.length);
  expect(groups).toHaveLength(1);
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
