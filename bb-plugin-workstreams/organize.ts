import { z } from "zod";
import { managerName } from "./manager.ts";
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
  z.object({
    kind: z.literal("parent"),
    threadId: z.string(),
    parentThreadId: z.string().nullable(),
  }),
  /** Historical log entries; organizing no longer plans native section removal. */
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
 * Why the planner did or did not act on a thread. Codes are stable identifiers
 * for diagnostics; they carry no thread content.
 */
export const ORGANIZE_NOTES = [
  "not-analyzed",
  "not-refreshed",
  "changed-since-analysis",
  "unclassified",
  "already-in-section",
  "later-manual-move",
  "archive-supersedes",
  "already-split",
  "split-medium-confidence",
  "parent-matches-manager",
] as const;
export type OrganizeNote = (typeof ORGANIZE_NOTES)[number];
export type OrganizeDecision = {
  threadId: string;
  /** Classified group the plan acted on, if any. */
  group: string | null;
  /** Native section the thread is in when planning. */
  sectionName: string | null;
  planned: Action["kind"][];
  notes: OrganizeNote[];
};

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
  return explainOrganize(threads, analysis, alreadySplit).actions;
}

/** {@link planOrganize} with a per-thread account of each decision. */
export function explainOrganize(
  threads: (Thread & { sectionName: string | null })[],
  analysis: Analysis | null,
  alreadySplit: Set<string>,
): { actions: Action[]; decisions: OrganizeDecision[] } {
  const items = new Map(analysis?.items.map((i) => [i.threadId, i]));
  const managers = threads.filter((thread) => managerName(thread.title));
  const managerGroup = (manager: Thread) =>
    (managerName(manager.title) ?? manager.title).toLowerCase();
  const matchesManager = (group: string, manager: Thread) => {
    const normalized = group.trim().toLowerCase();
    const name = managerGroup(manager);
    return normalized === name || normalized.startsWith(`${name}:`);
  };
  const actions: Action[] = [];
  const decisions: OrganizeDecision[] = [];
  for (const thread of threads) {
    const item = items.get(thread.id);
    const group = item?.group;
    const decision: OrganizeDecision = {
      threadId: thread.id,
      group: group ?? null,
      sectionName: thread.sectionName,
      planned: [],
      notes: [],
    };
    decisions.push(decision);
    const plan = (action: Action) => {
      actions.push(action);
      decision.planned.push(action.kind);
    };
    if (
      item?.refreshed &&
      item.updatedAt === thread.updatedAt &&
      item.group.toLowerCase() !== "unclassified" &&
      thread.parentThreadId &&
      managers.some((manager) => manager.id === thread.parentThreadId)
    ) {
      const correctManager = group
        ? managers.find((candidate) => matchesManager(group, candidate))
        : undefined;
      if (correctManager && correctManager.id !== thread.parentThreadId)
        plan({
          kind: "parent",
          threadId: thread.id,
          parentThreadId: correctManager.id,
        });
      else if (correctManager) decision.notes.push("parent-matches-manager");
    }
    if (!item) {
      decision.notes.push("not-analyzed");
      continue;
    }
    if (!item.refreshed) {
      decision.notes.push("not-refreshed");
      continue;
    }
    if (item.updatedAt !== thread.updatedAt) {
      decision.notes.push("changed-since-analysis");
      continue;
    }
    const split =
      item.drift?.confidence === "high" && !alreadySplit.has(thread.id);
    if (item.drift?.confidence === "high" && alreadySplit.has(thread.id))
      decision.notes.push("already-split");
    if (item.drift?.confidence === "medium")
      decision.notes.push("split-medium-confidence");
    if (item.archiveReason && item.state === "done") {
      plan({
        kind: "archive",
        threadId: thread.id,
        reason: item.archiveReason,
      });
      decision.notes.push("archive-supersedes");
      continue;
    }
    if (split)
      plan({
        kind: "split",
        threadId: thread.id,
        drift: item.drift!,
      });
    else if (
      item.title &&
      item.title !== thread.title &&
      messyTitle(thread.title)
    )
      plan({ kind: "retitle", threadId: thread.id, title: item.title });
    if (item.group === UNCLASSIFIED) decision.notes.push("unclassified");
    else if (item.group.toLowerCase() === thread.sectionName?.toLowerCase())
      decision.notes.push("already-in-section");
    else
      plan({
        kind: "section",
        threadId: thread.id,
        section: item.group,
      });
  }
  return { actions, decisions };
}

/**
 * Drops section moves that would undo a user's later manual move: once a
 * thread leaves the last section Workstreams assigned it, Workstreams only
 * files it again if its group now names that same assigned section. A
 * single-thread group must still follow an explicit Workstreams correction
 * (e.g. "v0 Dev Environment Provisioning" → "v0").
 */
export function respectManualSectionMoves(
  actions: Action[],
  threads: Pick<Thread, "id" | "sectionId">[],
  log: LogEntry[],
  sectionNamesById: ReadonlyMap<string, string>,
): { actions: Action[]; dropped: Set<string> } {
  const assignedByWorkstreams = new Map<string, string>();
  for (const e of log)
    if (e.action.kind === "section" && e.result === "done" && !e.undone)
      assignedByWorkstreams.set(e.action.threadId, e.action.section);
  const dropped = new Set<string>();
  const kept = actions.filter((action) => {
    if (action.kind !== "section") return true;
    const assigned = assignedByWorkstreams.get(action.threadId);
    const actual = threads.find((t) => t.id === action.threadId)?.sectionId;
    const current = actual ? sectionNamesById.get(actual) : undefined;
    const keep =
      !assigned || current === assigned || assigned === action.section;
    if (!keep) dropped.add(action.threadId);
    return keep;
  });
  return { actions: kept, dropped };
}

/** The organize run's complete plan: planner output after manual-move protection. */
export function planOrganizeRun(
  threads: (Thread & { sectionName: string | null })[],
  analysis: Analysis | null,
  alreadySplit: Set<string>,
  log: LogEntry[],
  sectionNamesById: ReadonlyMap<string, string>,
): { actions: Action[]; decisions: OrganizeDecision[] } {
  const planned = explainOrganize(threads, analysis, alreadySplit);
  const { actions, dropped } = respectManualSectionMoves(
    planned.actions,
    threads,
    log,
    sectionNamesById,
  );
  for (const decision of planned.decisions)
    if (dropped.has(decision.threadId)) {
      decision.planned = decision.planned.filter((kind) => kind !== "section");
      decision.notes.push("later-manual-move");
    }
  return { actions, decisions: planned.decisions };
}

/** Threads Workstreams split, including partial splits that left a fork. */
export function splitThreadIds(log: LogEntry[]): Set<string> {
  return new Set(
    log
      .filter(
        (e) =>
          e.action.kind === "split" &&
          !e.undone &&
          (e.result === "done" || !!e.undo?.forkId),
      )
      .map((e) => e.action.threadId),
  );
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
