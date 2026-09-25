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
    kind: z.literal("section"),
    threadId: z.string(),
    section: z.string(),
  }),
  /** Deletes a section no active thread uses; threadId is empty. */
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
      forkId: z.string().optional(),
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
  const actions: Action[] = [];
  for (const thread of threads) {
    const item = items.get(thread.id);
    if (!item || !item.refreshed || item.updatedAt !== thread.updatedAt)
      continue;
    const split =
      item.drift?.confidence === "high" && !alreadySplit.has(thread.id);
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
    case "split":
      return `Split “${name}”: new thread “${action.drift.mainlineTitle}” for ${action.drift.from}; original becomes “${action.drift.sideTitle}” and is compacted`;
    case "retitle":
      return `Rename “${name}” to “${action.title}”`;
    case "section":
      return `Move “${name}” to section ${action.section}`;
    case "removeSection":
      return `Remove empty section ${action.section}`;
  }
}
