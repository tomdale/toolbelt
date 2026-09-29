/**
 * Opt-in grouping diagnostics. They explain three separate decisions that can
 * each put a thread in the wrong group:
 *
 * 1. classification: what the model returned, which evidence it said decided
 *    the group, and how code then rewrote it (pins, side quests, name cleanup,
 *    batch failures, freshness checks);
 * 2. organize planning: which section/parent/title/archive actions were planned
 *    or skipped, and why;
 * 3. display grouping: which root thread and root property (native section,
 *    manager title, classification, or BB project fallback) named the group
 *    each thread is shown in.
 *
 * Diagnostics store and report only thread IDs, BB project names, repository
 * and checkout directory names, group/section labels, counts, and fixed reason
 * codes. They never contain prompts, excerpts, request timelines, recaps,
 * model titles, or archive reasons. Thread titles appear only when a caller
 * explicitly asks for them at report time; they are read live and not stored.
 */
import { z } from "zod";
import {
  BASES,
  UNCLASSIFIED,
  cleanGroupName,
  groupKey,
  type Analysis,
  type Context,
  type Thread,
} from "./model.ts";
import { isManagerTitle, managerName } from "./manager.ts";
import { projectThreadTrees, type TreeGroupSource } from "./tree-groups.ts";
import {
  ORGANIZE_NOTES,
  actionSchema,
  type OrganizeDecision,
} from "./organize.ts";
import { redact } from "./redact.ts";

/** Code-side rewrites between the model's group and the saved group, in order. */
export const STEP_STAGES = [
  /** A split or a manual native section fixed the group; see pinSource. */
  "pin",
  /** A detected side quest replaced the group. */
  "drift",
  /** Packaging descriptors were stripped ("Foo plugin" → "Foo"). */
  "clean",
  /** Typographic variants were unified with an earlier spelling. */
  "merge",
] as const;

/** Why a classification batch attempt was rejected. */
export const ATTEMPT_ERRORS = [
  /** The model call itself failed (host, Gateway, timeout). */
  "call-failed",
  /** The response was not JSON. */
  "invalid-json",
  /** JSON did not match the output schema. */
  "schema",
  /** Items did not cover every supplied thread exactly once. */
  "coverage",
] as const;
export type AttemptError = (typeof ATTEMPT_ERRORS)[number];

const label = z.string().max(200);
export const classifierTraceSchema = z.object({
  threadId: z.string(),
  batch: z.number().int().nonnegative(),
  /** Batch-local record ID the model saw instead of the BB thread ID. */
  recordId: z.string(),
  input: z.object({
    project: label,
    /** Last path segment of the project's git remote, without `.git`. */
    repository: label.nullable(),
    /** Last segment of the thread's checkout path. */
    checkout: label.nullable(),
    excerptChars: z.number().int().nonnegative(),
    hasInitialRequest: z.boolean(),
    recentRequests: z.number().int().nonnegative(),
    hasAssistantReport: z.boolean(),
    timelineRequests: z.number().int().nonnegative(),
    previousGroup: label.nullable(),
    pinnedGroup: label.nullable(),
    pinSource: z.enum(["split", "section"]).nullable(),
    settled: z.boolean(),
  }),
  /** Model output before any code rewrite; null when the batch failed. */
  model: z
    .object({
      group: label,
      /**
       * The model's own claim about its decisive evidence. It is not
       * verified and has been observed to name a request while the group
       * actually equals the BB project name; compare equalsProject.
       */
      basis: z.enum(BASES).nullable(),
      /** The group typographically equals the thread's BB project name. */
      equalsProject: z.boolean(),
      state: z.string().nullable(),
      titleChanged: z.boolean(),
      archiveProposed: z.boolean(),
    })
    .nullable(),
  steps: z.array(
    z.object({ stage: z.enum(STEP_STAGES), from: label, to: label }),
  ),
  drift: z
    .object({
      from: label,
      to: label,
      confidence: z.enum(["high", "medium", "low"]),
      splitSeq: z.number().int(),
    })
    .nullable(),
  /**
   * classified: this run's result was saved. kept-prior: the batch failed or
   * the thread changed during analysis, so the earlier result was kept
   * (marked not refreshed). dropped: no result could be kept.
   */
  outcome: z.enum(["classified", "kept-prior", "dropped"]),
  reason: z.enum(["batch-failed", "changed-during-analysis"]).nullable(),
  finalGroup: label.nullable(),
});
export type ClassifierTrace = z.infer<typeof classifierTraceSchema>;

export const batchTraceSchema = z.object({
  batch: z.number().int().nonnegative(),
  threads: z.number().int().nonnegative(),
  attempts: z.array(
    z.object({ ok: z.boolean(), error: z.enum(ATTEMPT_ERRORS).nullable() }),
  ),
  driftCheckFailed: z.boolean(),
});

export const analysisDiagnosticsSchema = z.object({
  at: z.number(),
  model: z.string(),
  fresh: z.boolean(),
  /** Whether the classifier was asked to name its decisive evidence. */
  basisRequested: z.boolean(),
  batches: z.array(batchTraceSchema),
  threads: z.array(classifierTraceSchema),
});
export type AnalysisDiagnostics = z.infer<typeof analysisDiagnosticsSchema>;

export const organizeDiagnosticsSchema = z.object({
  at: z.number(),
  decisions: z.array(
    z.object({
      threadId: z.string(),
      group: label.nullable(),
      sectionName: label.nullable(),
      planned: z.array(z.string()),
      notes: z.array(z.enum(ORGANIZE_NOTES)),
    }),
  ),
  /** Outcomes of the run's actions; details are Workstreams' own messages. */
  outcomes: z.array(
    z.object({
      threadId: z.string(),
      kind: z.string(),
      result: z.enum(["done", "failed", "planned"]),
      /** Destination section or parent for section/parent actions. */
      target: label.nullable(),
    }),
  ),
});
export type OrganizeDiagnostics = z.infer<typeof organizeDiagnosticsSchema>;

/** Reduces an organize plan and its logged outcomes to diagnostic data. */
export function organizeDiagnostics(
  at: number,
  decisions: OrganizeDecision[],
  outcomes: { action: z.infer<typeof actionSchema>; result: string }[],
): OrganizeDiagnostics {
  return organizeDiagnosticsSchema.parse({
    at,
    decisions,
    outcomes: outcomes.map(({ action, result }) => ({
      threadId: action.threadId,
      kind: action.kind,
      result,
      target:
        action.kind === "section"
          ? action.section
          : action.kind === "parent"
            ? action.parentThreadId
            : null,
    })),
  });
}

const lastSegment = (value: string | null | undefined): string | null => {
  const segment = value
    ?.replace(/[/\\]+$/, "")
    .split(/[/\\:]/)
    .at(-1)
    ?.replace(/\.git$/, "");
  return segment ? segment.slice(0, 200) : null;
};

/** Structural summary of one thread's classifier input; no content. */
export function traceInput(
  context: Context & { pinSource?: "split" | "section" },
): ClassifierTrace["input"] {
  const parts = context.excerpts.split("\n\n");
  return {
    project: context.project,
    repository: lastSegment(context.repository),
    checkout: lastSegment(context.path),
    excerptChars: context.excerpts.length,
    hasInitialRequest: parts.some((p) => p.startsWith("Initial user request")),
    recentRequests: parts.filter((p) => p.startsWith("Recent user request"))
      .length,
    hasAssistantReport: parts.some((p) =>
      p.startsWith("Last assistant report"),
    ),
    timelineRequests: context.timeline
      ? context.timeline.split("\n").length
      : 0,
    previousGroup: context.previousGroup ?? null,
    pinnedGroup: context.pinnedGroup ?? null,
    pinSource: context.pinnedGroup ? (context.pinSource ?? null) : null,
    settled: !!context.settled,
  };
}

/** Classifies a rejected batch attempt without keeping the error text. */
export function attemptError(error: unknown): AttemptError {
  if (error instanceof SyntaxError) return "invalid-json";
  if (error instanceof z.ZodError) return "schema";
  if (error instanceof Error && error.message.startsWith("Analysis must"))
    return "coverage";
  return "call-failed";
}

/** Records the cleanup/merge steps that normalizeGroups applied to a group. */
export function normalizationSteps(
  before: string,
  after: string,
): ClassifierTrace["steps"] {
  const cleaned = cleanGroupName(before);
  const steps: ClassifierTrace["steps"] = [];
  if (cleaned !== before)
    steps.push({ stage: "clean", from: before, to: cleaned });
  if (after !== cleaned)
    steps.push({ stage: "merge", from: cleaned, to: after });
  return steps;
}

const key = groupKey;

export type GroupingExplanation = {
  threadId: string;
  project: string;
  sectionName: string | null;
  /** The thread's own saved classification, if any. */
  classifiedGroup: string | null;
  refreshed: boolean | null;
  /** Group the page and sidebar show this thread in. */
  displayedGroup: string;
  displayedGroupId: string;
  /** Root property that named displayedGroup. */
  source: TreeGroupSource;
  rootThreadId: string;
  /** True when displayedGroup comes from an ancestor root, not this thread. */
  inherited: boolean;
  /** Classification disagrees with the displayed group. */
  disagrees: boolean;
  isManager: boolean;
  title?: string;
};

export type GroupSummary = {
  id: string;
  name: string;
  threads: number;
  roots: number;
  /** Roots per naming source; mixed sources share a bucket by name. */
  sources: Partial<Record<TreeGroupSource, number>>;
  inherited: number;
  disagreeing: number;
  /** The members' own classified groups, by count. */
  classifiedAs: Record<string, number>;
  projects: Record<string, number>;
};

/** A derived pattern worth investigating, with the thread IDs that show it. */
export type Finding = {
  code:
    | "project-fallback"
    | "classified-as-project"
    | "subtree-inheritance"
    | "section-overrides-manager-title"
    | "classification-differs-from-section";
  group: string;
  threadIds: string[];
};

export type GroupingReport = {
  threads: GroupingExplanation[];
  groups: GroupSummary[];
  findings: Finding[];
  warnings: string[];
};

const bump = (record: Record<string, number>, name: string) => {
  record[name] = (record[name] ?? 0) + 1;
};

/**
 * Explains the page/sidebar grouping with the same tree projection they use:
 * every thread follows its root, and the root is named by its native section,
 * manager title, classification, or BB project, in that order.
 */
export function explainGrouping(
  threads: Thread[],
  analysis: Analysis | null,
  sectionNames: ReadonlyMap<string, string>,
  options: { titles?: boolean } = {},
): GroupingReport {
  const items = new Map(analysis?.items.map((item) => [item.threadId, item]));
  const trees = threads.map((thread) => ({
    ...thread,
    displayTitle: thread.title,
    projectId: thread.project,
  }));
  const projection = projectThreadTrees(
    trees,
    new Map(
      trees.map((thread) => [
        thread.id,
        isManagerTitle(thread.title)
          ? ("manager" as const)
          : ("worker" as const),
      ]),
    ),
    new Map(analysis?.items.map((item) => [item.threadId, item.group])),
    sectionNames,
    new Map(trees.map((thread) => [thread.project, thread.project])),
  );
  const explained = trees.map((thread): GroupingExplanation => {
    const group = projection.groupByThread.get(thread.id)!;
    const root = projection.rootByThread.get(thread.id)!;
    const item = items.get(thread.id);
    return {
      threadId: thread.id,
      project: thread.project,
      sectionName: thread.sectionId
        ? (sectionNames.get(thread.sectionId) ?? null)
        : null,
      classifiedGroup: item?.group ?? null,
      refreshed: item ? item.refreshed : null,
      displayedGroup: group.name,
      displayedGroupId: group.id,
      source: projection.sourceByRoot.get(root.id) ?? group.source,
      rootThreadId: root.id,
      inherited: root.id !== thread.id,
      disagrees: !!item && key(item.group) !== key(group.name),
      isManager: isManagerTitle(thread.title),
      ...(options.titles ? { title: redact(thread.title).slice(0, 80) } : {}),
    };
  });
  const groups = projection.groups.map((group): GroupSummary => {
    const members = explained.filter((t) => t.displayedGroupId === group.id);
    const summary: GroupSummary = {
      id: group.id,
      name: group.name,
      threads: members.length,
      roots: group.roots.length,
      sources: {},
      inherited: members.filter((t) => t.inherited).length,
      disagreeing: members.filter((t) => t.disagrees).length,
      classifiedAs: {},
      projects: {},
    };
    for (const root of group.roots) {
      const source = projection.sourceByRoot.get(root.id) ?? group.source;
      summary.sources[source] = (summary.sources[source] ?? 0) + 1;
    }
    for (const member of members) {
      bump(summary.classifiedAs, member.classifiedGroup ?? "(not analyzed)");
      bump(summary.projects, member.project);
    }
    return summary;
  });
  groups.sort((a, b) => b.threads - a.threads || a.name.localeCompare(b.name));
  const findings: Finding[] = [];
  const add = (code: Finding["code"], group: string, ids: string[]) => {
    if (ids.length) findings.push({ code, group, threadIds: ids });
  };
  const byThread = new Map(threads.map((t) => [t.id, t]));
  for (const group of groups) {
    const members = explained.filter((t) => t.displayedGroupId === group.id);
    add(
      "project-fallback",
      group.name,
      members.filter((t) => t.source === "project").map((t) => t.threadId),
    );
    // The classifier's last-resort evidence is the BB project name. A label
    // equal to the project may be correct, but a large count of them in one
    // shared project is the signature of the fallback swallowing work.
    add(
      "classified-as-project",
      group.name,
      members
        .filter(
          (t) =>
            t.classifiedGroup &&
            t.classifiedGroup !== UNCLASSIFIED &&
            key(t.classifiedGroup) === key(t.project),
        )
        .map((t) => t.threadId),
    );
    add(
      "subtree-inheritance",
      group.name,
      members.filter((t) => t.inherited && t.disagrees).map((t) => t.threadId),
    );
    add(
      "section-overrides-manager-title",
      group.name,
      members
        .filter((t) => {
          if (t.inherited || t.source !== "section" || !t.isManager)
            return false;
          const product = managerName(byThread.get(t.threadId)!.title);
          return !!product && key(product) !== key(t.displayedGroup);
        })
        .map((t) => t.threadId),
    );
    add(
      "classification-differs-from-section",
      group.name,
      members
        .filter(
          (t) =>
            !t.inherited &&
            t.source === "section" &&
            t.disagrees &&
            t.classifiedGroup !== UNCLASSIFIED,
        )
        .map((t) => t.threadId),
    );
  }
  return {
    threads: explained,
    groups,
    findings,
    warnings: projection.warnings,
  };
}

/** Narrows a report to threads or a displayed group, keeping related findings. */
export function filterReport<
  T extends {
    grouping: GroupingReport;
    classifier: AnalysisDiagnostics | null;
    organize: { decisions: { threadId: string }[] } | null;
    plan: { decisions: { threadId: string }[] };
  },
>(report: T, filter: { threadId?: string; group?: string }): T {
  if (!filter.threadId && !filter.group) return report;
  const wanted = new Set(
    report.grouping.threads
      .filter(
        (t) =>
          t.threadId === filter.threadId ||
          (filter.group !== undefined &&
            key(t.displayedGroup) === key(filter.group)),
      )
      .map((t) => t.threadId),
  );
  const keep = <R extends { threadId: string }>(rows: R[]) =>
    rows.filter((row) => wanted.has(row.threadId));
  return {
    ...report,
    grouping: {
      ...report.grouping,
      threads: keep(report.grouping.threads),
      groups: report.grouping.groups.filter((g) =>
        report.grouping.threads.some(
          (t) => wanted.has(t.threadId) && t.displayedGroupId === g.id,
        ),
      ),
      findings: report.grouping.findings
        .map((f) => ({
          ...f,
          threadIds: f.threadIds.filter((id) => wanted.has(id)),
        }))
        .filter((f) => f.threadIds.length),
    },
    classifier: report.classifier && {
      ...report.classifier,
      threads: keep(report.classifier.threads),
    },
    organize: report.organize && {
      ...report.organize,
      decisions: keep(report.organize.decisions),
    },
    plan: { ...report.plan, decisions: keep(report.plan.decisions) },
  };
}

/** One privacy-safe log line summarizing a diagnosed analysis run. */
export function diagnosticsSummary(diagnostics: AnalysisDiagnostics): string {
  const count = (values: (string | null)[]) => {
    const counts: Record<string, number> = {};
    for (const value of values) if (value) bump(counts, value);
    return counts;
  };
  const threads = diagnostics.threads;
  return `Workstreams diagnostics (${diagnostics.model}): ${JSON.stringify({
    threads: threads.length,
    finalGroups: count(threads.map((t) => t.finalGroup)),
    basis: count(threads.map((t) => t.model?.basis ?? null)),
    modelGroupEqualsProject: threads.filter((t) => t.model?.equalsProject)
      .length,
    steps: count(threads.flatMap((t) => t.steps.map((s) => s.stage))),
    outcomes: count(threads.map((t) => t.outcome)),
    failedAttempts: diagnostics.batches.reduce(
      (n, b) => n + b.attempts.filter((a) => !a.ok).length,
      0,
    ),
  })}`;
}
