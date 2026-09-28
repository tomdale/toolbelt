import { z } from "zod";
import {
  UNCLASSIFIED,
  driftSchema,
  type Analysis,
  type Thread,
} from "./model.ts";

/**
 * Organizing changes the user's threads: it splits side quests into their
 * own threads, retitles messy titles, and files threads into sections named
 * after their workstream. Every change is logged with enough state to undo
 * it, except compaction, which BB cannot reverse.
 */
export const actionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("split"),
    threadId: z.string(),
    drift: driftSchema,
  }),
  z.object({
    kind: z.literal("retitle"),
    threadId: z.string(),
    title: z.string(),
  }),
  z.object({
    kind: z.literal("archive"),
    threadId: z.string(),
    reason: z.string().trim().min(1).max(180),
  }),
  z.object({
    kind: z.literal("section"),
    threadId: z.string(),
    section: z.string(),
  }),
  /** Deletes a section no active thread uses; threadId is empty. */
  z.object({
    kind: z.literal("parent"),
    threadId: z.string(),
    parentThreadId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("removeSection"),
    threadId: z.literal(""),
    section: z.string(),
    sectionId: z.string(),
  }),
]);
export type Action = z.infer<typeof actionSchema>;

export const logEntrySchema = z.object({
  id: z.string(),
  at: z.number(),
  action: actionSchema,
  /** "planned" entries come from fixture replay, which never changes threads. */
  result: z.enum(["done", "failed", "planned"]),
  detail: z.string().default(""),
  undo: z
    .object({
      title: z.string().nullable().optional(),
      sectionId: z.string().nullable().optional(),
      sectionName: z.string().nullable().optional(),
      parentThreadId: z.string().nullable().optional(),
      /** Section Workstreams moved the thread into; differs if user moved it. */
      workstreamsSectionId: z.string().nullable().optional(),
      forkId: z.string().optional(),
      archived: z.boolean().optional(),
    })
    .optional(),
  undone: z.boolean().default(false),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

/** Titles that are raw prompts rather than names: long, URL-bearing, or truncated. */
export function messyTitle(title: string): boolean {
  return (
    title.length > 70 ||
    /https?:\/\//.test(title) ||
    /(\.\.\.|…)$/.test(title.trim())
  );
}

/**
 * Plans the organize pass. Only high-confidence splits are planned; medium
 * ones are offered on the row instead. Threads that changed since analysis
 * are skipped so actions never rest on stale conclusions.
 */
export function planOrganize(
  threads: (Thread & { sectionName: string | null })[],
  analysis: Analysis | null,
  alreadySplit: Set<string>,
): Action[] {
  const items = new Map(analysis?.items.map((i) => [i.threadId, i]));
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const isDispatch = (thread: Thread) =>
    !thread.parentThreadId &&
    (thread.environmentPath ?? "")
      .replace(/\\/g, "/")
      .replace(/\/$/, "")
      .toLowerCase() === "/users/tomdale/code/tomdaleos";
  const dispatchIds = new Set(
    threads.filter(isDispatch).map((thread) => thread.id),
  );
  const managers = threads.filter(
    (thread) =>
      thread.parentThreadId &&
      dispatchIds.has(thread.parentThreadId) &&
      /\s*[—–-]\s*manager$/i.test(thread.title),
  );
  const managerGroup = (manager: Thread) =>
    manager.title
      .replace(/\s*[—–-]\s*manager$/i, "")
      .trim()
      .toLowerCase();
  const matchesManager = (group: string, manager: Thread) => {
    const normalized = group.trim().toLowerCase();
    const name = managerGroup(manager);
    return normalized === name || normalized.startsWith(`${name}:`);
  };
  const actions: Action[] = [];
  for (const thread of threads) {
    const item = items.get(thread.id);
    // Dispatch owns cross-project intake and is never reparented or split.
    if (dispatchIds.has(thread.id)) continue;
    const hierarchyParent = thread.parentThreadId
      ? byId.get(thread.parentThreadId)
      : undefined;
    const group = items.get(thread.id)?.group;
    if (
      hierarchyParent &&
      dispatchIds.has(hierarchyParent.id) &&
      !managers.some((manager) => manager.id === thread.id) &&
      item?.refreshed &&
      item.updatedAt === thread.updatedAt &&
      item.group.toLowerCase() !== "unclassified"
    ) {
      const manager = group
        ? managers.find((candidate) => matchesManager(group, candidate))
        : undefined;
      if (manager)
        actions.push({
          kind: "parent",
          threadId: thread.id,
          parentThreadId: manager.id,
        });
    } else if (
      hierarchyParent &&
      managers.some((manager) => manager.id === hierarchyParent.id) &&
      item?.refreshed &&
      item.updatedAt === thread.updatedAt &&
      item.group.toLowerCase() !== "unclassified"
    ) {
      const correctManager = group
        ? managers.find((candidate) => matchesManager(group, candidate))
        : undefined;
      if (correctManager && correctManager.id !== hierarchyParent.id)
        actions.push({
          kind: "parent",
          threadId: thread.id,
          parentThreadId: correctManager.id,
        });
    }
    if (!item || !item.refreshed || item.updatedAt !== thread.updatedAt) {
      // A newly detected, agreed high-confidence split is itself permission
      // to retitle/file the side-quest original even if it ran since analysis.
      // The split executor still independently refuses to fork a live thread.
      if (
        item?.refreshed &&
        item.drift?.confidence === "high" &&
        !alreadySplit.has(thread.id)
      )
        actions.push({ kind: "split", threadId: thread.id, drift: item.drift });
      continue;
    }
    const split =
      item.drift?.confidence === "high" && !alreadySplit.has(thread.id);
    if (item.archiveReason && item.state === "done") {
      actions.push({
        kind: "archive",
        threadId: thread.id,
        reason: item.archiveReason,
      });
      continue;
    }
    if (split)
      actions.push({
        kind: "split",
        threadId: thread.id,
        drift: item.drift!,
      });
    else if (
      item.title &&
      item.title !== thread.title &&
      messyTitle(thread.title)
    )
      actions.push({ kind: "retitle", threadId: thread.id, title: item.title });
    if (
      item.group !== UNCLASSIFIED &&
      item.group.toLowerCase() !== thread.sectionName?.toLowerCase()
    )
      actions.push({
        kind: "section",
        threadId: thread.id,
        section: item.group,
      });
  }
  return actions;
}

export function describe(action: Action, titles: Map<string, string>): string {
  const name = titles.get(action.threadId) ?? action.threadId;
  switch (action.kind) {
    case "parent":
      return `Fix parentage for “${name}”`;
    case "split":
      return `Split “${name}”: new thread “${action.drift.mainlineTitle}” for ${action.drift.from}; original becomes “${action.drift.sideTitle}” and is compacted`;
    case "retitle":
      return `Rename “${name}” to “${action.title}”`;
    case "archive":
      return `Archive “${name}”: ${action.reason}`;
    case "section":
      return `Move “${name}” to section ${action.section}`;
    case "removeSection":
      return `Remove empty section ${action.section}`;
  }
}
