import { basename, isAbsolute, join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BATCH_SIZE,
  analysisSchema,
  normalizeAnalysis,
  snapshotSchema,
  UNCLASSIFIED,
  fixtureSchema,
  classifyBatch,
  normalizeGroups,
  applyDrift,
  mapConcurrent,
  MODEL,
  groupKey,
  type Analysis,
  type Classification,
  type Drift,
  type Snapshot,
  type Thread,
  type Context,
} from "./model";
import { redact } from "./redact";
import { detectDrift } from "./drift";
import { cropGeometry, hotlineBannerSvg } from "./hotline-banner";
import {
  IMAGE_MODEL,
  bannerKey,
  bannerMotif,
  hotlineBannerSignature,
  bannerPrompt,
} from "./banner";
import {
  parseSummaries,
  summaryBatches,
  summaryInput,
  summaryPrompt,
} from "./summary";
import {
  describe,
  logEntrySchema,
  planOrganizeRun,
  splitThreadIds,
  type Action,
  type LogEntry,
} from "./organize";
import {
  analysisDiagnosticsSchema,
  attemptError,
  diagnosticsSummary,
  explainGrouping,
  filterReport,
  normalizationSteps,
  organizeDiagnostics,
  organizeDiagnosticsSchema,
  traceInput,
  type AnalysisDiagnostics,
  type ClassifierTrace,
  type OrganizeDiagnostics,
} from "./diagnostics";
import { hostContract } from "./host-contract";
import { isManagerTitle, managerName } from "./manager";
import { buildSidebar } from "./sidebar-model";
import {
  contextExcerpt,
  initialRequest,
  inputText,
  requestTimeline,
  manualSectionGroup,
} from "./context";

const viewSchema = snapshotSchema.extend({
  sections: z.record(z.string(), z.string()).default({}),
  log: z.array(logEntrySchema),
  /** Banner image URL by group name, for groups that have one. */
  banners: z.record(z.string(), z.string()),
  mode: z.enum(["auto", "suggest"]),
  organizing: z.boolean(),
});
export type View = z.infer<typeof viewSchema>;
const threadInput = z.object({ threadId: z.string() });
const parentLinkSchema = z
  .object({ id: z.string(), title: z.string() })
  .nullable();
const ok = z.object({ ok: z.boolean() });
export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: viewSchema },
  parentLink: {
    input: z.object({ threadId: z.string().min(1) }),
    output: parentLinkSchema,
  },
  /** Analysis only, for the sidebar, which reads threads from BB's live view. */
  sidebar: {
    input: z.null(),
    output: z.object({
      analysis: analysisSchema.nullable(),
      banners: z.record(z.string(), z.string()),
      hierarchy: z.object({
        roles: z.record(z.string(), z.enum(["manager", "worker"])),
        managers: z.record(z.string(), z.string()),
      }),
      owners: z.record(
        z.string(),
        z.object({ viaWorkers: z.array(z.string()) }),
      ),
    }),
  },
  createManager: {
    input: z.object({ groupId: z.string().min(1).max(200) }).strict(),
    output: z.object({ threadId: z.string().min(1) }),
  },
  organize: { input: z.null(), output: ok },
  split: { input: threadInput, output: ok },
  undo: { input: z.object({ id: z.string() }), output: ok },
  analyze: { input: z.null(), output: z.object({ ok: z.boolean() }) },
  /** Read-only grouping diagnostics; see diagnostics.ts for what they contain. */
  diagnostics: {
    input: z
      .object({
        threadId: z.string().min(1).optional(),
        group: z.string().min(1).max(200).optional(),
      })
      .strict()
      .nullable(),
    output: z.unknown(),
  },
  cancel: { input: z.null(), output: z.object({ ok: z.boolean() }) },
});

export const SPLIT_NOTE = "Workstreams split this thread";
class PartialSplitError extends Error {
  constructor(
    message: string,
    readonly undo: NonNullable<LogEntry["undo"]>,
  ) {
    super(message);
  }
}
function isSplitNote(data: unknown): boolean {
  return inputText((data as { input?: unknown }).input).startsWith(SPLIT_NOTE);
}
function absolute(path: string): string {
  if (!isAbsolute(path)) throw new Error("Use an absolute path.");
  return path;
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS banners (key TEXT PRIMARY KEY, name TEXT NOT NULL, motif TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, cost REAL NOT NULL, at INTEGER NOT NULL)",
  ]);
  const get = (key: string): unknown => {
    const row = db.prepare("SELECT value FROM state WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  };
  const put = (key: string, value: unknown) =>
    db
      .prepare(
        "INSERT INTO state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  // Fixture mode replays a frozen context snapshot (for evaluation and
  // screenshots) and keeps its results apart from live analysis.
  let fixture: { path: string; contexts: Context[] } | null = null;
  const analysisKey = () => (fixture ? "fixture-analysis" : "thread-analysis");
  const loadFixture = async (path: string | null) => {
    fixture = path
      ? {
          path,
          contexts: fixtureSchema.parse(
            JSON.parse(await readFile(path, "utf8")),
          ),
        }
      : null;
    put("fixture", path);
    analysis = normalizeAnalysis(
      analysisSchema.nullable().catch(null).parse(get(analysisKey())),
    );
    if (analysis) put(analysisKey(), analysis);
    error = null;
    notify();
  };
  let analysis: Analysis | null = null;
  let progress: Snapshot["progress"] = null;
  let error: string | null = null;
  let pending = false;
  let run: AbortController | null = null;
  let lastHost: string | null = null;
  const inference = bb.hosts.experimental_client({ contract: hostContract });
  const settings = bb.settings.define({
    organize: {
      type: "select",
      label: "After analysis: organize threads automatically, or only suggest",
      description:
        "Auto splits high-confidence side quests, renames messy titles, and files threads into workstream sections. Every change is logged and can be undone.",
      options: ["auto", "suggest"],
      default: "auto",
    },
    hostId: {
      type: "string",
      label: "Analysis machine ID (blank uses the only connected machine)",
      default: "",
    },
    diagnostics: {
      type: "boolean",
      label: "Record grouping diagnostics on every analysis",
      description:
        "Keeps the latest run's classifier and organize decisions (thread IDs, project and group names, evidence categories, and reason codes; no conversation text) for `bb workstreams diagnose`. Diagnosed runs also ask the model to name its decisive evidence.",
      default: false,
    },
    showParentThreadLink: {
      type: "boolean",
      label: "Show parent thread link in thread header",
      description:
        "Show a link to the parent thread in the header of child threads.",
      default: false,
    },
  });
  const notify = () => bb.realtime.publish("changed", {});
  try {
    const saved = get("fixture");
    if (typeof saved === "string") await loadFixture(saved);
  } catch {
    put("fixture", null);
  }
  analysis ??= normalizeAnalysis(
    analysisSchema.nullable().catch(null).parse(get(analysisKey())),
  );
  if (analysis) put(analysisKey(), analysis);
  const advance = (
    stage: NonNullable<Snapshot["progress"]>["stage"],
    completed: number,
    total: number,
  ) => {
    progress = { stage, completed, total };
    notify();
  };
  async function inventory(signal?: AbortSignal): Promise<Thread[]> {
    if (fixture)
      return fixture.contexts.map(
        ({ excerpts: _e, path: _p, ...thread }) => thread,
      );
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const byId = new Map(projects.map((p) => [p.id, p]));
    const threads: Thread[] = [];
    // Page the entire active list, not just the most recently touched threads.
    for (let offset = 0; ; offset += 100) {
      const page = await bb.sdk.threads.list({
        archived: false,
        includeHidden: false,
        limit: 100,
        offset,
        signal,
      });
      for (const t of page) {
        if (
          t.archivedAt !== null ||
          t.deletedAt !== null ||
          t.visibility === "hidden" ||
          // Mainline forks made by a split are ordinary threads; anything
          // else this plugin creates would be internal.
          (t.originPluginId === bb.pluginId &&
            t.originKind !== "fork" &&
            !isManagerTitle(t.title ?? t.titleFallback ?? ""))
        )
          continue;
        const project = byId.get(t.projectId);
        threads.push({
          id: t.id,
          title: t.title ?? t.titleFallback ?? "Untitled thread",
          project: project?.name ?? "Unknown project",
          repository: project?.gitRemoteUrl ?? null,
          status: t.runtime.displayStatus,
          sectionId: t.sectionId,
          parentThreadId: t.parentThreadId ?? null,
          environmentPath: t.environmentPath ?? null,
          hasPendingInteraction: t.hasPendingInteraction,
          updatedAt: t.updatedAt,
          latestAttentionAt: t.latestAttentionAt,
        });
      }
      if (page.length < 100) break;
    }
    return [...new Map(threads.map((t) => [t.id, t])).values()];
  }
  /** Split originals and their split seqs, from the change log. */
  const splits = () =>
    log.filter(
      (e) => e.action.kind === "split" && e.result === "done" && !e.undone,
    );
  let splitAt = new Map<string, number>();
  /** Reads bounded, attributed conversation context for each thread. */
  async function collect(
    threads: Thread[],
    warnings: string[],
    signal: AbortSignal,
    onRead: () => void = () => {},
  ): Promise<Context[]> {
    splitAt = new Map(
      splits().map((e) => [
        e.action.threadId,
        e.action.kind === "split" ? e.action.drift.splitSeq : 0,
      ]),
    );
    const forks = new Set(splits().map((e) => e.undo?.forkId));
    const pinned = new Map<
      string,
      { group: string; source: "split" | "section" }
    >();
    for (const e of splits())
      if (e.action.kind === "split") {
        pinned.set(e.action.threadId, {
          group: e.action.drift.to,
          source: "split",
        });
        if (e.undo?.forkId)
          pinned.set(e.undo.forkId, {
            group: e.action.drift.from,
            source: "split",
          });
      }
    const previous = new Map(
      (analysis?.items ?? [])
        .filter((i) => i.group !== UNCLASSIFIED)
        .map((i) => [i.threadId, i.group]),
    );
    const names = new Map(
      (await bb.sdk.threadSections.list()).map((s) => [s.id, s.name]),
    );
    for (const t of threads) {
      // A native section is a correction only when it differs from the last
      // successful Workstreams assignment. A --fresh run drops the previous
      // analysis but must still respect genuinely manual sidebar moves.
      const manual = manualSectionGroup(t.sectionId, names, log, t.id);
      if (manual) pinned.set(t.id, { group: manual, source: "section" });
    }
    return mapConcurrent(threads, async (thread): Promise<Context> => {
      signal.throwIfAborted();
      let initial = "";
      let prompts: Awaited<ReturnType<typeof bb.sdk.threads.promptHistory>> =
        [];
      let report: string | null = null;
      let path: string | null = null;
      let timeline = "";
      try {
        // Page every request: a side-quest switch can fall anywhere in a long
        // thread, including the middle omitted by the former head/tail sample.
        const query = {
          threadId: thread.id,
          types: ["client/turn/requested"] as ["client/turn/requested"],
          limit: "100",
          order: "asc" as const,
          signal,
        };
        const all: Awaited<ReturnType<typeof bb.sdk.threads.events.list>> = [];
        let afterSeq: string | undefined;
        for (;;) {
          const page = await bb.sdk.threads.events.list({
            ...query,
            ...(afterSeq ? { afterSeq } : {}),
          });
          all.push(...page);
          if (page.length < 100) break;
          afterSeq = String(page.at(-1)!.seq);
        }
        const since = splitAt.get(thread.id) ?? 0;
        const events = all
          // A split original is about the side quest from its split point on;
          // a split fork's seed note is Workstreams' own text, not a request.
          .filter((e) => (e.seq ?? since) >= since && !isSplitNote(e.data));
        initial = initialRequest(events);
        timeline = requestTimeline(events);
      } catch {
        signal.throwIfAborted();
        warnings.push(
          `Could not read the initial request for ${thread.title}.`,
        );
      }
      try {
        prompts = (
          await bb.sdk.threads.promptHistory({
            threadId: thread.id,
            limit: "4",
            signal,
          })
        )
          .filter((p) => !isSplitNote(p))
          .slice(0, 3);
      } catch {
        warnings.push(`Could not read prompts for ${thread.title}.`);
      }
      try {
        const { output } = await bb.sdk.threads.output({
          threadId: thread.id,
          signal,
        });
        report = output;
      } catch {
        warnings.push(`Could not read the last response for ${thread.title}.`);
      }
      try {
        const detail = await bb.sdk.threads.get({
          threadId: thread.id,
          signal,
        });
        if (detail.environmentId)
          path = (
            await bb.sdk.environments.get({
              environmentId: detail.environmentId,
            })
          ).path;
      } catch {
        /* Conversation context remains usable without a checkout path. */
      }
      onRead();
      return {
        ...thread,
        title: redact(thread.title),
        path,
        excerpts: contextExcerpt(initial, prompts, report),
        timeline,
        // Already-split threads, on either side, are not re-checked for drift,
        // and keep the groups the split gave them.
        settled: splitAt.has(thread.id) || forks.has(thread.id),
        pinnedGroup: pinned.get(thread.id)?.group,
        pinSource: pinned.get(thread.id)?.source,
        previousGroup: freshRun ? undefined : previous.get(thread.id),
      };
    });
  }
  async function analyze(signal: AbortSignal, diagnose = false) {
    const started = Date.now();
    const stats = {
      seconds: 0,
      calls: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      summarySeconds: 0,
      summaryCalls: 0,
      summaryCost: 0,
    };
    // Drift checks are nested inside concurrent classification batches; cap
    // all model calls together so the two independent checks don't flood the
    // host/Gateway with dozens of simultaneous Pi processes.
    let activeCalls = 0;
    const waiters: (() => void)[] = [];
    const withCallSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (activeCalls >= 4)
        await new Promise<void>((resolve) => waiters.push(resolve));
      activeCalls++;
      try {
        return await fn();
      } finally {
        activeCalls--;
        waiters.shift()?.();
      }
    };
    const complete = async (
      prompt: string,
      hostId: string,
      kind: "classification" | "summary" = "classification",
    ) => {
      signal.throwIfAborted();
      stats.calls++;
      if (kind === "summary") stats.summaryCalls++;
      const { text, usage } = await withCallSlot(() =>
        inference.call(
          "complete",
          { prompt },
          { hostId, signal, timeoutMs: 130_000 },
        ),
      );
      stats.inputTokens += usage.input;
      stats.outputTokens += usage.output;
      stats.cost += usage.cost;
      if (kind === "summary") stats.summaryCost += usage.cost;
      return redact(text);
    };
    const threads = await inventory(signal);
    if (!threads.length) {
      analysis = {
        at: Date.now(),
        needsYouCount: 0,
        items: [],
        warnings: [],
        summaries: {},
      };
      put(analysisKey(), analysis);
      return;
    }
    const connected = (await bb.sdk.hosts.list()).filter(
      (h) => h.status === "connected",
    );
    const { hostId } = await settings.get();
    const host = hostId.trim()
      ? connected.find((h) => h.id === hostId.trim())
      : connected.length === 1
        ? connected[0]
        : undefined;
    if (!host)
      throw new Error(
        "Choose a connected analysis machine in Workstreams settings. It needs Pi with AI Gateway configured.",
      );
    lastHost = host.id;
    const warnings: string[] = [];
    let read = 0;
    advance("reading", 0, threads.length);
    const contexts = fixture
      ? fixture.contexts.filter((c) => threads.some((t) => t.id === c.id))
      : await collect(threads, warnings, signal, () =>
          advance("reading", ++read, threads.length),
        );
    const batches: Context[][] = [];
    for (let i = 0; i < contexts.length; i += BATCH_SIZE)
      batches.push(contexts.slice(i, i + BATCH_SIZE));
    let classified = 0;
    advance("classifying", 0, threads.length);
    // Diagnostics trace each thread through the model and every code rewrite.
    const traces = new Map<string, ClassifierTrace>();
    const batchTraces: AnalysisDiagnostics["batches"] = [];
    if (diagnose)
      batches.forEach((batch, b) => {
        batchTraces.push({
          batch: b,
          threads: batch.length,
          attempts: [],
          driftCheckFailed: false,
        });
        batch.forEach((context, i) =>
          traces.set(context.id, {
            threadId: context.id,
            batch: b,
            recordId: String(i + 1),
            input: traceInput(context),
            model: null,
            steps: [],
            drift: null,
            outcome: "dropped",
            reason: null,
            finalGroup: null,
          }),
        );
      });
    const prior = new Map(analysis?.items.map((i) => [i.threadId, i]));
    // Seeding earlier names was evaluated (eval/README.md) and increased wrong
    // merges without improving accuracy, so each run names groups afresh.
    const seed: string[] = [];
    const kept: Analysis["items"] = [];
    const items = (
      await mapConcurrent(batches, async (batch, b) => {
        const batchTrace = batchTraces[b];
        // Drift detection is a separate small call per batch, run alongside.
        const drifts = detectDrift(batch, (prompt) =>
          complete(prompt, host.id),
        ).catch(() => {
          signal.throwIfAborted();
          stats.failedCalls++;
          if (batchTrace) batchTrace.driftCheckFailed = true;
          warnings.push(
            `Could not check ${batch.length} threads for side quests.`,
          );
          return new Map<string, Drift>();
        });
        let result: Classification[] = [];
        // One retry absorbs occasional output-contract slips; then keep prior results.
        for (let attempt = 0; attempt < 2 && !result.length; attempt++) {
          try {
            result = await classifyBatch(
              batch,
              (prompt) => complete(prompt, host.id),
              seed,
              diagnose
                ? {
                    basis: true,
                    onRaw: (raw) => {
                      const trace = traces.get(raw.threadId)!;
                      const context = batch.find((c) => c.id === raw.threadId);
                      trace.model = {
                        group: raw.group,
                        basis: raw.basis ?? null,
                        equalsProject:
                          groupKey(raw.group) === groupKey(trace.input.project),
                        state: raw.state ?? null,
                        titleChanged:
                          !!raw.title && raw.title !== context?.title,
                        archiveProposed: !!raw.archiveReason,
                      };
                    },
                  }
                : {},
            );
            batchTrace?.attempts.push({ ok: true, error: null });
          } catch (e) {
            signal.throwIfAborted();
            stats.failedCalls++;
            batchTrace?.attempts.push({ ok: false, error: attemptError(e) });
          }
        }
        if (!result.length) {
          warnings.push(
            `Could not classify ${batch.length} threads; earlier results are shown where available.`,
          );
          for (const t of batch) {
            const old = prior.get(t.id);
            if (old) kept.push({ ...old, refreshed: false });
            const trace = traces.get(t.id);
            if (trace) {
              trace.outcome = old ? "kept-prior" : "dropped";
              trace.reason = "batch-failed";
              trace.finalGroup = old?.group ?? null;
            }
          }
        }
        const found = await drifts;
        classified += batch.length;
        advance("classifying", classified, threads.length);
        return result.map((item) => {
          const drift = found.get(item.threadId) ?? null;
          const drifted = applyDrift({ ...item, drift });
          const trace = traces.get(item.threadId);
          if (trace) {
            if (trace.model && trace.model.group !== item.group)
              trace.steps.push({
                stage: "pin",
                from: trace.model.group,
                to: item.group,
              });
            if (drifted.group !== item.group)
              trace.steps.push({
                stage: "drift",
                from: item.group,
                to: drifted.group,
              });
            trace.drift = drift && {
              from: drift.from,
              to: drift.to,
              confidence: drift.confidence,
              splitSeq: drift.splitSeq,
            };
          }
          return drifted;
        });
      })
    ).flat();
    signal.throwIfAborted();
    if (!items.length && batches.length)
      throw new Error(
        "Classification failed for every thread. Previous results are unchanged.",
      );
    const timestamps = new Map(threads.map((t) => [t.id, t.updatedAt]));
    const normalized = normalizeGroups(items);
    normalized.forEach((item, i) => {
      const trace = traces.get(item.threadId);
      if (!trace) return;
      trace.steps.push(...normalizationSteps(items[i].group, item.group));
      trace.outcome = "classified";
      trace.finalGroup = item.group;
    });
    let next: Analysis = {
      at: Date.now(),
      needsYouCount: items.filter(
        (i) =>
          i.state === "needs_decision" ||
          !!threads.find((t) => t.id === i.threadId)?.hasPendingInteraction,
      ).length,
      items: [
        ...normalized.map((i) => ({
          ...i,
          needsYou:
            i.state === "needs_decision" ||
            !!threads.find((t) => t.id === i.threadId)?.hasPendingInteraction,
          updatedAt: timestamps.get(i.threadId)!,
          refreshed: true,
        })),
        ...kept,
      ],
      warnings,
      summaries: {},
    };
    next = normalizeAnalysis(next)!;
    try {
      const input = summaryInput({
        items: next.items.map((i) => ({
          ...i,
          needsYou:
            !!i.needsYou ||
            i.state === "needs_decision" ||
            !!threads.find((t) => t.id === i.threadId)?.hasPendingInteraction,
        })),
      });
      if (input.length) {
        advance("summarizing", 0, input.length);
        let summarized = 0;
        const summaryStarted = Date.now();
        // One group per call avoids truncated or incomplete multi-group JSON
        // from the fast model and makes a single failure local to one summary.
        const summaries = await mapConcurrent(
          input.map((group) => [group]),
          async (batch) => {
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const summaries = parseSummaries(
                  await complete(summaryPrompt(batch), host.id, "summary"),
                  batch.map((g) => g.name),
                );
                for (const group of batch) {
                  const summary = summaries.get(group.name);
                  const exactNeedsYou = group.threads.filter(
                    (t) => t.needsYou,
                  ).length;
                  if (summary && summary.needsYou !== exactNeedsYou)
                    summaries.set(group.name, {
                      ...summary,
                      needsYou: exactNeedsYou,
                    });
                }
                advance("summarizing", ++summarized, input.length);
                return summaries;
              } catch {
                signal.throwIfAborted();
              }
            }
            // A bad summary response must not discard classifications or the
            // summaries already saved for this group.
            advance("summarizing", ++summarized, input.length);
            return new Map(
              batch.flatMap(({ name }) =>
                analysis?.summaries?.[name]
                  ? [[name, analysis.summaries[name]] as const]
                  : [],
              ),
            );
          },
        );
        next.summaries = Object.fromEntries(summaries.flatMap((s) => [...s]));
        if (next.summaries && Object.keys(next.summaries).length < input.length)
          warnings.push("Some workstream summaries could not be refreshed.");
        stats.summarySeconds =
          Math.round((Date.now() - summaryStarted) / 100) / 10;
      }
    } catch {
      signal.throwIfAborted();
      stats.failedCalls++;
      warnings.push("Could not summarize workstreams.");
    }
    // Inference may outlive the inventory snapshot. Preserve the prior result
    // for any thread that changed while the model was working.
    if (!fixture) {
      advance("verifying", 0, next.items.length);
      let verified = 0;
      const current: Analysis["items"] = [];
      for (const item of next.items) {
        signal.throwIfAborted();
        let unchanged = false;
        try {
          const detail = await bb.sdk.threads.get({ threadId: item.threadId });
          unchanged =
            detail.updatedAt === timestamps.get(item.threadId) &&
            detail.archivedAt === null &&
            detail.deletedAt === null;
        } catch {
          signal.throwIfAborted();
        }
        if (unchanged) current.push(item);
        else {
          const old = prior.get(item.threadId);
          if (old) current.push({ ...old, refreshed: false });
          const trace = traces.get(item.threadId);
          if (trace?.outcome === "classified") {
            trace.outcome = old ? "kept-prior" : "dropped";
            trace.reason = "changed-during-analysis";
            trace.finalGroup = old?.group ?? null;
          }
          warnings.push(
            `Thread ${item.threadId} changed during analysis; not refreshed.`,
          );
        }
        advance("verifying", ++verified, next.items.length);
      }
      next.items = current;
      next.needsYouCount = current.filter((item) => item.needsYou).length;
      const freshGroups = new Set(
        current.filter((item) => item.refreshed).map((item) => item.group),
      );
      const staleGroups = new Set(
        current.filter((item) => !item.refreshed).map((item) => item.group),
      );
      for (const group of staleGroups) delete next.summaries[group];
      for (const group of Object.keys(next.summaries))
        if (!freshGroups.has(group)) delete next.summaries[group];
    }
    stats.seconds = Math.round((Date.now() - started) / 100) / 10;
    stats.cost = Math.round(stats.cost * 10000) / 10000;
    stats.summaryCost = Math.round(stats.summaryCost * 10000) / 10000;
    analysis = normalizeAnalysis({ ...next, stats });
    put(analysisKey(), analysis);
    if (diagnose) {
      const diagnostics: AnalysisDiagnostics = analysisDiagnosticsSchema.parse({
        at: analysis!.at,
        model: MODEL,
        fresh: freshRun,
        basisRequested: true,
        batches: batchTraces,
        threads: [...traces.values()],
      });
      put(diagnosticsKey(), diagnostics);
      bb.log.info(diagnosticsSummary(diagnostics));
    }
  }
  const diagnosticsKey = () =>
    fixture ? "fixture-analysis-diagnostics" : "analysis-diagnostics";
  const organizeDiagnosticsKey = () =>
    fixture ? "fixture-organize-diagnostics" : "organize-diagnostics";
  const logKey = () => (fixture ? "fixture-organize-log" : "organize-log");
  let log: LogEntry[] = z
    .array(logEntrySchema)
    .catch([])
    .parse(get(logKey()) ?? []);
  let organizing = false;
  const record = (entry: Omit<LogEntry, "id" | "at" | "undone">): LogEntry => {
    const saved = {
      ...entry,
      id: crypto.randomUUID(),
      at: Date.now(),
      undone: false,
    };
    log.push(saved);
    log = log.slice(-500);
    put(logKey(), log);
    return saved;
  };
  const splitting = new Set<string>();
  async function sectionIds(signal?: AbortSignal) {
    const sections = await bb.sdk.threadSections.list();
    signal?.throwIfAborted();
    const byName = new Map(sections.map((s) => [s.name.toLowerCase(), s.id]));
    const names = new Map(sections.map((s) => [s.id, s.name]));
    return {
      names,
      list: async () => names,
      async ensure(name: string) {
        const existing = byName.get(name.toLowerCase());
        if (existing) return existing;
        signal?.throwIfAborted();
        const created = await bb.sdk.threadSections.create({ name });
        byName.set(name.toLowerCase(), created.id);
        names.set(created.id, created.name);
        return created.id;
      },
    };
  }
  /** Seqs of real user requests before the split point, latest first. */
  async function mainlineSeqs(threadId: string, splitSeq: number) {
    const events = await bb.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      beforeSeq: String(splitSeq),
      order: "desc",
      limit: "20",
    });
    const seqs = events
      .filter((e) => {
        const text = inputText((e.data as { input?: unknown }).input);
        return text && !text.startsWith("[bb system]");
      })
      .map((e) => e.seq);
    if (!seqs.length)
      throw new Error("No mainline request precedes the split.");
    return seqs;
  }
  async function execute(
    action: Action,
    sections: Awaited<ReturnType<typeof sectionIds>>,
    splitPolicy: "manual" | "auto",
    expectedAt: number,
    signal?: AbortSignal,
  ): Promise<Pick<LogEntry, "detail" | "undo">> {
    // Historical removal entries remain readable for Undo, but native BB
    // sections have no durable ownership marker or complete membership query.
    if (action.kind === "removeSection")
      throw new Error("Workstreams does not delete native BB sections.");
    signal?.throwIfAborted();
    const detail = await bb.sdk.threads.get({ threadId: action.threadId });
    if (detail.archivedAt !== null || detail.deletedAt !== null)
      throw new Error("Thread is archived or deleted.");
    const recheck = async () => {
      const current = await bb.sdk.threads.get({ threadId: action.threadId });
      if (
        current.archivedAt !== null ||
        current.deletedAt !== null ||
        current.updatedAt !== expectedAt
      )
        throw new Error("Thread changed since action planning.");
    };
    if (detail.updatedAt !== expectedAt)
      throw new Error("Thread changed since action planning.");
    const before = {
      title: detail.title,
      sectionId: detail.sectionId,
      parentThreadId: detail.parentThreadId,
      sectionName: detail.sectionId
        ? ((await sections.list()).get(detail.sectionId) ?? null)
        : null,
    };
    if (action.kind === "retitle") {
      signal?.throwIfAborted();
      await recheck();
      await bb.sdk.threads.update({
        threadId: action.threadId,
        title: action.title,
      });
      return { detail: "", undo: before };
    }
    if (action.kind === "archive") {
      if (detail.status !== "idle" && detail.status !== "error")
        throw new Error("Thread is running; archive it when it is idle.");
      const children = await bb.sdk.threads.childSummary({
        threadId: action.threadId,
      });
      if (children.nonDeletedChildCount > 0)
        throw new Error("Thread has child threads; archive it manually.");
      signal?.throwIfAborted();
      await recheck();
      await bb.sdk.threads.archive({ threadId: action.threadId });
      return { detail: action.reason, undo: { ...before, archived: true } };
    }
    if (action.kind === "section") {
      signal?.throwIfAborted();
      const sectionId = await sections.ensure(action.section);
      signal?.throwIfAborted();
      await recheck();
      await bb.sdk.threads.update({ threadId: action.threadId, sectionId });
      return {
        detail: "",
        undo: { ...before, workstreamsSectionId: sectionId },
      };
    }
    if (action.kind === "parent") {
      signal?.throwIfAborted();
      await recheck();
      await bb.sdk.threads.update({
        threadId: action.threadId,
        parentThreadId: action.parentThreadId ?? undefined,
        ...(action.parentThreadId ? {} : { clearParentThread: true }),
      });
      return { detail: "Parentage updated.", undo: before };
    }
    const item = analysis?.items.find((i) => i.threadId === action.threadId);
    if (
      !item?.refreshed ||
      !item.drift ||
      JSON.stringify(item.drift) !== JSON.stringify(action.drift)
    )
      throw new Error("Split analysis is missing or no longer current.");
    if (
      item.drift.confidence === "low" ||
      (splitPolicy === "auto" && item.drift.confidence !== "high")
    )
      throw new Error("Split confidence is below the required threshold.");
    if (
      log.some(
        (e) =>
          e.action.kind === "split" &&
          !e.undone &&
          (e.result === "done" || !!e.undo?.forkId) &&
          (e.action.threadId === action.threadId ||
            e.undo?.forkId === action.threadId),
      )
    )
      throw new Error("Thread has already been split.");
    const visible = (await inventory()).find((t) => t.id === action.threadId);
    if (
      !visible ||
      visible.hasPendingInteraction ||
      (visible.status !== "idle" && visible.status !== "error") ||
      (detail.status !== "idle" && detail.status !== "error")
    )
      throw new Error(
        "Thread is not eligible, idle, or has a pending interaction.",
      );
    if (
      item.updatedAt !== detail.updatedAt ||
      item.updatedAt !== visible.updatedAt
    )
      throw new Error("Thread changed since split analysis; analyze it again.");
    // Confirm that the proposed pivot is still a real user request, not a
    // synthetic note or an event that disappeared from the source timeline.
    const pivot = await bb.sdk.threads.events.list({
      threadId: action.threadId,
      types: ["client/turn/requested"],
      afterSeq: String(item.drift.splitSeq - 1),
      order: "asc",
      limit: "1",
    });
    const request = pivot[0];
    const text =
      request && inputText((request.data as { input?: unknown }).input);
    if (
      request?.seq !== item.drift.splitSeq ||
      !text ||
      text.startsWith("[bb system]") ||
      text.startsWith(SPLIT_NOTE)
    )
      throw new Error(
        "Split point is no longer a user request; analyze it again.",
      );
    await recheck();
    signal?.throwIfAborted();
    const { drift } = action;
    // BB refuses to fork inside turns recorded under another thread's provider
    // session (e.g. delivered manager messages); fall back to earlier turns.
    let fork: Awaited<ReturnType<typeof bb.sdk.threads.fork>> | null = null;
    let lastError: unknown;
    let forkedAt = 0;
    for (const sourceSeqEnd of (
      await mainlineSeqs(action.threadId, drift.splitSeq)
    ).slice(0, 5)) {
      signal?.throwIfAborted();
      await recheck();
      try {
        fork = await bb.sdk.threads.fork({
          sourceThreadId: action.threadId,
          sourceSeqEnd,
          title: drift.mainlineTitle,
          ...(detail.environmentId
            ? {
                environment: {
                  type: "reuse" as const,
                  environmentId: detail.environmentId,
                },
              }
            : {}),
          agentContextSeed: [
            {
              type: "text" as const,
              mentions: [],
              visibility: "agent-only" as const,
              text: `${SPLIT_NOTE} from ${action.threadId} at the point where it moved from ${drift.from} to ${drift.to}. This thread continues the ${drift.from} work; the ${drift.to} work continues in the original thread.`,
            },
          ],
          pluginMetadata: { splitFrom: action.threadId },
        });
        forkedAt = sourceSeqEnd;
        break;
      } catch (e) {
        signal?.throwIfAborted();
        lastError = e;
      }
    }
    if (!fork) throw lastError;
    try {
      signal?.throwIfAborted();
      const sectionId = await sections.ensure(drift.from);
      signal?.throwIfAborted();
      await bb.sdk.threads.update({ threadId: fork.id, sectionId });
      signal?.throwIfAborted();
      await bb.sdk.threads.update({
        threadId: action.threadId,
        title: drift.sideTitle,
      });
      signal?.throwIfAborted();
      await bb.sdk.threads.compact({ threadId: action.threadId });
    } catch (e) {
      throw new PartialSplitError(
        `Fork ${fork.id} was created, but split setup or compaction failed: ${e instanceof Error ? e.message : String(e)}`,
        { ...before, forkId: fork.id },
      );
    }
    return {
      detail: `New thread ${fork.id} (mainline through #${forkedAt}); original compacted.`,
      undo: { ...before, forkId: fork.id },
    };
  }
  /** Applies actions one at a time; callers receive each logged outcome. */
  async function perform(
    actions: Action[],
    splitPolicy: "manual" | "auto" = "auto",
    plannedAt: Map<string, number> = new Map(),
    signal?: AbortSignal,
    outcomeCounts?: { done: number; failed: number },
    onProgress?: (completed: number) => void,
  ): Promise<LogEntry[]> {
    const outcomes: LogEntry[] = [];
    if (fixture) {
      const titles = new Map(fixture.contexts.map((c) => [c.id, c.title]));
      for (const action of actions) {
        signal?.throwIfAborted();
        outcomes.push(
          record({
            action,
            result: "planned",
            detail: describe(action, titles),
          }),
        );
        onProgress?.(outcomes.length);
      }
      notify();
      return outcomes;
    }
    const sections = await sectionIds(signal);
    const failedSplits = new Set<string>();
    const failed = new Set<string>();
    const succeeded = new Set<string>();
    for (const action of actions) {
      if (signal?.aborted) break;
      let locked = false;
      try {
        if (failedSplits.has(action.threadId))
          throw new Error("Skipped because the split failed.");
        if (action.kind === "split") {
          if (splitting.has(action.threadId))
            throw new Error("A split is already in progress for this thread.");
          splitting.add(action.threadId);
          locked = true;
        }
        signal?.throwIfAborted();
        const expectedAt = plannedAt.get(action.threadId);
        if (expectedAt === undefined || failed.has(action.threadId))
          throw new Error("Thread changed since action planning.");
        const actionResult = await execute(
          action,
          sections,
          splitPolicy,
          expectedAt,
          signal,
        );
        const current = await bb.sdk.threads.get({ threadId: action.threadId });
        plannedAt.set(action.threadId, current.updatedAt);
        succeeded.add(action.threadId);
        outcomes.push(record({ action, result: "done", ...actionResult }));
        if (outcomeCounts) outcomeCounts.done++;
      } catch (e) {
        failed.add(action.threadId);
        if (action.kind === "split") failedSplits.add(action.threadId);
        outcomes.push(
          record({
            action,
            result: "failed",
            detail: signal?.aborted
              ? "Cancelled during action; check for partial changes."
              : e instanceof Error
                ? e.message
                : String(e),
            ...(e instanceof PartialSplitError ? { undo: e.undo } : {}),
          }),
        );
        if (outcomeCounts) outcomeCounts.failed++;
        if (signal?.aborted) break;
      } finally {
        if (locked) splitting.delete(action.threadId);
        onProgress?.(outcomes.length);
      }
    }
    // Keep successful plugin edits current; failed actions remain explicitly stale.
    if (analysis) {
      analysis = {
        ...analysis,
        items: analysis.items.map((item) =>
          failed.has(item.threadId)
            ? { ...item, refreshed: false }
            : succeeded.has(item.threadId) && plannedAt.has(item.threadId)
              ? { ...item, updatedAt: plannedAt.get(item.threadId)! }
              : item,
        ),
      };
      put(analysisKey(), analysis);
    }
    notify();
    return outcomes;
  }
  /** Plans organize against current threads without changing anything. */
  async function planCurrent(signal?: AbortSignal) {
    const threads = await inventory(signal);
    const sectionNames = fixture
      ? new Map<string, string>()
      : (await sectionIds(signal)).names;
    const namesById = new Map(
      (await bb.sdk.threadSections.list()).map((s) => [s.id, s.name]),
    );
    const plan = planOrganizeRun(
      threads.map((t) => ({
        ...t,
        sectionName: t.sectionId
          ? (sectionNames.get(t.sectionId) ?? null)
          : null,
      })),
      analysis,
      splitThreadIds(log),
      log,
      namesById,
    );
    return { threads, ...plan };
  }
  async function organize(
    signal?: AbortSignal,
    result?: { done: number; failed: number },
    diagnose = false,
  ) {
    signal?.throwIfAborted();
    organizing = true;
    notify();
    try {
      const { threads, actions, decisions } = await planCurrent(signal);
      signal?.throwIfAborted();
      if (progress?.stage === "organizing")
        advance("organizing", 0, actions.length);
      const outcomes = await perform(
        actions,
        "auto",
        new Map(threads.map((thread) => [thread.id, thread.updatedAt])),
        signal,
        result,
        progress?.stage === "organizing"
          ? (completed) => advance("organizing", completed, actions.length)
          : undefined,
      );
      if (diagnose)
        put(
          organizeDiagnosticsKey(),
          organizeDiagnostics(Date.now(), decisions, outcomes),
        );
    } finally {
      organizing = false;
      notify();
    }
  }
  async function undo(id: string) {
    const entry = log.find((e) => e.id === id);
    if (
      !entry ||
      entry.undone ||
      (entry.result !== "done" &&
        !(entry.action.kind === "split" && entry.undo?.forkId)) ||
      !entry.undo
    )
      throw new Error("Nothing to undo for this entry.");
    if (entry.action.kind === "removeSection") {
      await bb.sdk.threadSections.create({ name: entry.action.section });
      entry.undone = true;
      put(logKey(), log);
      notify();
      return;
    }
    const { threadId } = entry.action;
    if (entry.undo.forkId)
      await bb.sdk.threads.archive({ threadId: entry.undo.forkId });
    if (entry.undo.archived) await bb.sdk.threads.unarchive({ threadId });
    if (entry.undo.title !== undefined)
      await bb.sdk.threads.update({ threadId, title: entry.undo.title });
    if (entry.action.kind === "section" || entry.action.kind === "parent") {
      let sectionId = entry.undo.sectionId ?? null;
      const exists = sectionId
        ? (await bb.sdk.threadSections.list()).some((s) => s.id === sectionId)
        : false;
      if (!exists && entry.undo.sectionName)
        sectionId = await (await sectionIds()).ensure(entry.undo.sectionName);
      await bb.sdk.threads.update({
        threadId,
        ...(entry.action.kind === "section" ? { sectionId } : {}),
        ...(entry.undo.parentThreadId
          ? { parentThreadId: entry.undo.parentThreadId }
          : { clearParentThread: true }),
      });
    }
    entry.undone = true;
    put(logKey(), log);
    notify();
  }
  const BANNER_PATH = "/banner";
  const bannerRows = () =>
    db.prepare("SELECT key, at FROM banners").all() as {
      key: string;
      at: number;
    }[];
  function bannerUrls(): Record<string, string> {
    const have = new Map(bannerRows().map((r) => [r.key, r.at]));
    const urls: Record<string, string> = {};
    for (const name of Object.keys(analysis?.summaries ?? {})) {
      const at = have.get(bannerKey(name));
      if (at)
        urls[name] =
          `/api/v1/plugins/${bb.pluginId}/http${BANNER_PATH}?key=${encodeURIComponent(bannerKey(name))}&v=${at}`;
    }
    return urls;
  }
  bb.http.route("GET", BANNER_PATH, (c) => {
    const row = db
      .prepare("SELECT mime, data FROM banners WHERE key = ?")
      .get(c.req.query("key") ?? "") as
      { mime: string; data: Buffer } | undefined;
    if (!row) return c.notFound();
    if (row.mime === "image/svg+xml")
      return new Response(new Uint8Array(row.data), {
        headers: {
          "content-type": row.mime,
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    return new Response(new Uint8Array(row.data), {
      headers: {
        "content-type": row.mime,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });
  /** Generates banners for summarized groups that don't have one yet. */
  /** Crop a centered wide slice at native aspect; never stretch a square image. */
  async function cropHotlineArt(
    input: Buffer,
  ): Promise<{ data: Buffer; mime: string }> {
    const dir = await mkdtemp(join(tmpdir(), "workstreams-hotline-"));
    const source = join(dir, "source.png");
    const cropped = join(dir, "crop.png");
    try {
      await writeFile(source, input);
      await promisify(execFile)("sips", [
        "-s",
        "format",
        "png",
        source,
        "--out",
        source + ".png",
      ]);
      const png = source + ".png";
      const { stdout } = await promisify(execFile)("sips", [
        "-g",
        "pixelWidth",
        "-g",
        "pixelHeight",
        png,
      ]);
      const width = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]);
      const height = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]);
      if (!width || !height)
        throw new Error("Could not read generated image dimensions.");
      // Crop the source to 232:18 at native scale: preserve the whole image
      // width when it is already banner-shaped; never stretch X and Y apart.
      const geometry = cropGeometry(width, height);
      await promisify(execFile)("sips", [
        "--cropToHeightWidth",
        String(geometry.height),
        String(geometry.width),
        "--cropOffset",
        String(geometry.top),
        String(geometry.left),
        png,
        "--out",
        cropped,
      ]);
      await promisify(execFile)("sips", [
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "82",
        cropped,
        "--out",
        join(dir, "crop.jpg"),
      ]);
      return {
        data: await readFile(join(dir, "crop.jpg")),
        mime: "image/jpeg",
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async function ensureBanners(hostId: string, signal: AbortSignal) {
    const cached = new Map(
      (
        db.prepare("SELECT key, motif FROM banners").all() as {
          key: string;
          motif: string;
        }[]
      ).map((row) => [row.key, row.motif]),
    );
    const missing = Object.entries(analysis?.summaries ?? {}).filter(
      ([name, summary]) =>
        cached.get(bannerKey(name)) !==
        hotlineBannerSignature(name, bannerMotif(name, summary.motif)),
    );
    if (progress?.stage === "banners") advance("banners", 0, missing.length);
    let generated = 0;
    if (missing.length)
      bb.log.info(
        `Generating ${missing.length} Hotline banners: ${missing.map(([name]) => name).join(", ")}`,
      );
    await mapConcurrent(missing, async ([name, summary]) => {
      try {
        const image = await inference.call(
          "image",
          {
            prompt: bannerPrompt(name, summary.motif),
            model: IMAGE_MODEL,
          },
          { hostId, signal, timeoutMs: 120_000 },
        );
        // Use the actual ratio returned by the provider instead of assuming a
        // square source: the crop helper preserves the center band at native
        // scale. The source aspect is stored here only for cost/QA review.
        const art = await cropHotlineArt(Buffer.from(image.data, "base64"));
        const svg = Buffer.from(
          hotlineBannerSvg(name, art.mime, art.data.toString("base64")),
          "utf8",
        );
        db.prepare(
          "INSERT OR REPLACE INTO banners (key, name, motif, mime, data, cost, at) VALUES (?,?,?,?,?,?,?)",
        ).run(
          bannerKey(name),
          name,
          hotlineBannerSignature(name, bannerMotif(name, summary.motif)),
          "image/svg+xml",
          svg,
          image.cost,
          Date.now(),
        );
        notify();
      } catch (error) {
        signal.throwIfAborted();
        bb.log.warn(
          `Could not generate Hotline banner for ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (progress?.stage === "banners")
          advance("banners", ++generated, missing.length);
      }
    });
  }
  bb.background.service("thread-analysis", {
    async start(signal) {
      while (!signal.aborted) {
        if (pending) {
          pending = false;
          run = new AbortController();
          const onStop = () => run?.abort();
          signal.addEventListener("abort", onStop);
          const runSignal = AbortSignal.any([signal, run.signal]);
          let analyzed = false;
          const organizeResult = { done: 0, failed: 0 };
          try {
            const diagnose = diagnoseRun || (await settings.get()).diagnostics;
            await analyze(runSignal, diagnose);
            analyzed = true;
            runSignal.throwIfAborted();
            if ((await settings.get()).organize === "auto") {
              advance("organizing", 0, 0);
              await organize(runSignal, organizeResult, diagnose);
            }
            runSignal.throwIfAborted();
            if (lastHost) {
              advance("banners", 0, 0);
              await ensureBanners(lastHost, runSignal);
            }
            runSignal.throwIfAborted();
          } catch (e) {
            error = runSignal.aborted
              ? analyzed
                ? `Analysis completed; follow-up cancelled. ${organizeResult.done} organize actions completed, ${organizeResult.failed} failed; remaining actions skipped. Check the organize log for changes.`
                : "Analysis cancelled. Previous results are unchanged."
              : e instanceof Error
                ? e.message
                : String(e);
          } finally {
            signal.removeEventListener("abort", onStop);
            run = null;
            progress = null;
            notify();
          }
        }
        try {
          await delay(200, undefined, { signal });
        } catch {
          break;
        }
      }
    },
  });
  /** fresh: ignore previous groups this run, to let corrected rules regroup. */
  let freshRun = false;
  /** diagnose: record diagnostics for this run regardless of the setting. */
  let diagnoseRun = false;
  const start = (options: { fresh?: boolean; diagnose?: boolean } = {}) => {
    if (progress) throw new Error("An analysis is already running.");
    freshRun = !!options.fresh;
    diagnoseRun = !!options.diagnose;
    pending = true;
    error = null;
    advance("preparing", 0, 0);
    return { ok: true };
  };
  const cancel = () => {
    if (!progress) return { ok: false };
    if (pending) {
      pending = false;
      progress = null;
      error = "Analysis cancelled. Previous results are unchanged.";
      notify();
    }
    run?.abort();
    return { ok: true };
  };
  /**
   * Read-only grouping diagnostics: the display projection with provenance,
   * the organize plan current threads would get now, and the latest recorded
   * classifier and organize traces. Thread titles only on explicit request.
   */
  async function diagnosticsReport(
    options: { threadId?: string; group?: string; titles?: boolean } = {},
  ) {
    const { threads, actions, decisions } = await planCurrent();
    // Match the page: fixture replay has no native section names.
    const sectionNames = fixture
      ? new Map<string, string>()
      : new Map(
          (await bb.sdk.threadSections.list()).map((s) => [s.id, s.name]),
        );
    const classifier = analysisDiagnosticsSchema
      .nullable()
      .catch(null)
      .parse(get(diagnosticsKey()));
    const organizeRun: OrganizeDiagnostics | null = organizeDiagnosticsSchema
      .nullable()
      .catch(null)
      .parse(get(organizeDiagnosticsKey()));
    const plannedKinds: Record<string, number> = {};
    for (const action of actions)
      plannedKinds[action.kind] = (plannedKinds[action.kind] ?? 0) + 1;
    return filterReport(
      {
        fixture: fixture ? basename(fixture.path) : null,
        analysisAt: analysis?.at ?? null,
        /** False when the classifier trace is from an earlier analysis. */
        classifierIsCurrent: classifier ? classifier.at === analysis?.at : null,
        grouping: explainGrouping(threads, analysis, sectionNames, {
          titles: options.titles,
        }),
        /** What Organize would do now; nothing is performed. */
        plan: { actions: plannedKinds, decisions },
        classifier,
        organize: organizeRun,
      },
      options,
    );
  }
  const snapshot = async (): Promise<View> => ({
    threads: await inventory(),
    sections: fixture
      ? {}
      : Object.fromEntries(
          (await bb.sdk.threadSections.list()).map((s) => [s.id, s.name]),
        ),
    analysis,
    progress,
    error,
    fixture: fixture ? basename(fixture.path) : null,
    log: log.slice(-100),
    banners: bannerUrls(),
    mode: (await settings.get()).organize === "suggest" ? "suggest" : "auto",
    organizing,
  });
  // Serialize creation requests within this plugin instance; the SDK has no
  // conditional thread-create primitive, so external creators can still race.
  let managerCreation = Promise.resolve();
  const createManager = (groupId: string): Promise<{ threadId: string }> => {
    const run = managerCreation.then(async () => {
      if (fixture)
        throw new Error("Manager creation is unavailable in fixture mode.");
      const [projects, sections] = await Promise.all([
        bb.sdk.projects.list({ includePersonal: true }),
        bb.sdk.threadSections.list(),
      ]);
      const active: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
      for (let offset = 0; ; offset += 100) {
        const page = await bb.sdk.threads.list({
          archived: false,
          includeHidden: false,
          limit: 100,
          offset,
        });
        active.push(
          ...page.filter(
            (t) =>
              t.archivedAt === null &&
              t.deletedAt === null &&
              t.visibility !== "hidden" &&
              (t.originPluginId !== bb.pluginId ||
                t.originKind === "fork" ||
                isManagerTitle(t.title ?? t.titleFallback ?? "")),
          ),
        );
        if (page.length < 100) break;
      }
      const model = buildSidebar(
        active.map((t) => ({
          id: t.id,
          displayTitle: t.title ?? t.titleFallback ?? "Untitled thread",
          parentThreadId: t.parentThreadId ?? null,
          sectionId: t.sectionId,
          projectId: t.projectId,
          status: t.runtime.displayStatus,
          hasPendingInteraction: t.hasPendingInteraction,
          isUnread: false,
          isPinned: false,
          updatedAt: t.updatedAt,
          latestAttentionAt: t.latestAttentionAt,
        })),
        analysis,
        new Map(sections.map((s) => [s.id, s.name])),
        new Map(projects.map((p) => [p.id, p.name])),
      );
      const group = model.groups.find((g) => g.id === groupId);
      if (!group) throw new Error("This product group is no longer available.");
      const projectIds = new Set(group.rows.map((r) => r.thread.projectId));
      if (group.manager) projectIds.add(group.manager.thread.projectId);
      if (projectIds.size !== 1)
        throw new Error(
          "This group spans projects; choose a single project first.",
        );
      const projectId = [...projectIds][0];
      if (!projects.some((p) => p.id === projectId))
        throw new Error("The group's project is no longer available.");
      const sectionId = groupId.startsWith("section:")
        ? groupId.slice("section:".length)
        : null;
      if (sectionId && !sections.some((s) => s.id === sectionId))
        throw new Error("The group's section is no longer available.");
      const existing = active.find(
        (t) =>
          t.projectId === projectId &&
          isManagerTitle(t.title ?? t.titleFallback ?? "") &&
          (sectionId
            ? t.sectionId === sectionId
            : !t.sectionId &&
              managerName(t.title ?? t.titleFallback ?? "")?.toLowerCase() ===
                group.name.toLowerCase()),
      );
      if (existing) return { threadId: existing.id };
      if (!group.unmanaged)
        throw new Error("This group already has a manager.");
      const product = group.name.trim();
      if (!product || product === "Section" || product === "Unknown project")
        throw new Error("Cannot determine a product name for this group.");
      const created = await bb.sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        input: [
          {
            type: "text",
            text: `You are the Workstreams manager for the product ${JSON.stringify(product)} in this BB project. Help coordinate its workstream threads when the user provides priorities or tasks. Do not assume a specific task or start work on other threads yet; ask what the user wants coordinated first.`,
            mentions: [],
          },
        ],
        title: `${product} — manager`,
        ...(sectionId ? { sectionId } : {}),
      });
      notify();
      return { threadId: created.id };
    });
    managerCreation = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  bb.rpc.register(rpcContract, {
    snapshot,
    createManager: ({ groupId }) => createManager(groupId),
    parentLink: async ({ threadId }) => {
      if (!(await settings.get()).showParentThreadLink) return null;
      try {
        const child = await bb.sdk.threads.get({ threadId });
        if (
          child.deletedAt !== null ||
          !child.parentThreadId ||
          child.parentThreadId === threadId
        )
          return null;
        const parent = await bb.sdk.threads.get({
          threadId: child.parentThreadId,
        });
        if (
          !parent ||
          parent.deletedAt !== null ||
          parent.projectId !== child.projectId
        )
          return null;
        return {
          id: parent.id,
          title: parent.title ?? parent.titleFallback ?? "Untitled thread",
        };
      } catch {
        return null;
      }
    },
    analyze: async () => start(),
    diagnostics: async (input) => diagnosticsReport(input ?? {}),
    sidebar: async () => {
      if (fixture)
        return {
          analysis: null,
          banners: {},
          owners: {},
          hierarchy: { roles: {}, managers: {} },
        };
      const active = await inventory();
      const owners: Record<string, { viaWorkers: string[] }> = {};
      const managerReports = new Map<string, { at: number; text: string }[]>();
      const byId = new Map(active.map((t) => [t.id, t]));
      const managers = active.filter((thread) => isManagerTitle(thread.title));
      if (managers.length) {
        for (const manager of managers) {
          const events = await bb.sdk.threads.events.list({
            threadId: manager.id,
            types: ["client/turn/requested"],
            order: "desc",
            limit: "5",
          });
          managerReports.set(
            manager.id,
            events
              .map((e) => ({
                at: e.createdAt,
                text: inputText((e.data as { input?: unknown }).input),
              }))
              .filter((e) => e.text),
          );
          owners[manager.id] = { viaWorkers: [] };
        }
        for (const worker of active) {
          let cursor = worker;
          let manager: Thread | undefined;
          while (cursor.parentThreadId) {
            const parent = byId.get(cursor.parentThreadId);
            if (!parent) break;
            if (managers.some((m) => m.id === parent.id)) {
              manager = parent;
              break;
            }
            cursor = parent;
          }
          if (!manager) continue;
          const [workerEvents, completions] = await Promise.all([
            bb.sdk.threads.events.list({
              threadId: worker.id,
              types: ["client/turn/requested"],
              order: "desc",
              limit: "1",
            }),
            bb.sdk.threads.events.list({
              threadId: worker.id,
              types: ["turn/completed"],
              order: "desc",
              limit: "1",
            }),
          ]);
          const completedAt = completions[0]?.createdAt ?? 0;
          const requestedAt = workerEvents[0]?.createdAt ?? 0;
          const report = (managerReports.get(manager.id) ?? []).find(
            (event) => event.at > Math.max(completedAt, requestedAt),
          );
          const reportText = report?.text.toLowerCase() ?? "";
          const workerTitle = worker.title.toLowerCase();
          const workerPrefix = workerTitle.slice(0, 18);
          const referred =
            report &&
            reportText.includes(workerPrefix) &&
            /\b(ask|talk|work with|coordinate|continue in|go to|message|reply|answer)\b/i.test(
              reportText,
            );
          const explicitlyAsks = workerEvents.some((event) => {
            const input = inputText((event.data as { input?: unknown }).input);
            return /\?\s*$|\b(please|can you|could you|let me know|confirm|choose|which|what do you think)\b/i.test(
              input,
            );
          });
          if (
            report &&
            !referred &&
            !worker.hasPendingInteraction &&
            !explicitlyAsks
          )
            owners[manager.id].viaWorkers.push(worker.title);
        }
      }
      const hierarchy = {
        roles: Object.fromEntries(
          active.map((t) => [
            t.id,
            managers.some((m) => m.id === t.id) ? "manager" : "worker",
          ]),
        ) as Record<string, "manager" | "worker">,
        managers: Object.fromEntries(
          active.flatMap((thread) => {
            let cursor = thread;
            const seen = new Set<string>();
            while (cursor.parentThreadId && !seen.has(cursor.id)) {
              seen.add(cursor.id);
              const parent = byId.get(cursor.parentThreadId);
              if (!parent) return [];
              if (managers.some((manager) => manager.id === parent.id)) {
                return thread.id === parent.id ? [] : [[thread.id, parent.id]];
              }
              cursor = parent;
            }
            return [];
          }),
        ),
      };
      return { analysis, banners: bannerUrls(), owners, hierarchy };
    },
    organize: async () => {
      if (progress || organizing) throw new Error("Busy; try again shortly.");
      await organize(undefined, undefined, (await settings.get()).diagnostics);
      return { ok: true };
    },
    split: async ({ threadId }) => {
      const item = analysis?.items.find((i) => i.threadId === threadId);
      if (!item?.drift) throw new Error("No side quest found for this thread.");
      if (progress || organizing) throw new Error("Busy; try again shortly.");
      const [outcome] = await perform(
        [{ kind: "split", threadId, drift: item.drift }],
        "manual",
        new Map([[threadId, item.updatedAt]]),
      );
      if (outcome.result !== "done")
        throw new Error(outcome.detail || "Split was not performed.");
      return { ok: true };
    },
    undo: async ({ id }) => {
      await undo(id);
      return { ok: true };
    },
    cancel: async () => cancel(),
  });
  for (const event of [
    "thread.created",
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.archived",
    "thread.unarchived",
    "thread.deleted",
  ] as const) {
    bb.events.on(event, ({ thread }) => {
      if (thread.originPluginId !== bb.pluginId) notify();
    });
  }
  bb.cli.register({
    name: "workstreams",
    summary: "List active threads or analyze their project/product groups",
    commands: [
      {
        name: "list",
        summary: "Show active threads and the latest analysis",
        usage: "bb workstreams list",
      },
      {
        name: "analyze",
        summary: "Start parallel AI Gateway classification",
        usage: "bb workstreams analyze [--fresh] [--diagnose]",
      },
      {
        name: "diagnose",
        summary:
          "Explain grouping, the current organize plan, and the latest recorded classifier trace (read-only)",
        usage:
          "bb workstreams diagnose [--thread <id>] [--group <name>] [--titles]",
      },
      {
        name: "cancel",
        summary: "Cancel a running analysis",
        usage: "bb workstreams cancel",
      },
      {
        name: "organize",
        summary:
          "Split side quests, rename messy titles, and file threads into workstream sections (planned only during fixture replay)",
        usage: "bb workstreams organize",
      },
      {
        name: "export",
        summary:
          "Write live thread context to a private JSON file for fixture replay",
        usage: "bb workstreams export /absolute/private/path.json",
      },
      {
        name: "fixture",
        summary:
          "Replay a frozen context file instead of live threads, or turn replay off",
        usage: "bb workstreams fixture /absolute/path.json | off",
      },
    ],
    async run(argv) {
      try {
        if (argv[0] === "list")
          return { exitCode: 0, stdout: JSON.stringify(await snapshot()) };
        if (argv[0] === "analyze")
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              start({
                fresh: argv.includes("--fresh"),
                diagnose: argv.includes("--diagnose"),
              }),
            ),
          };
        if (argv[0] === "diagnose") {
          const value = (flag: string) => {
            const i = argv.indexOf(flag);
            if (i < 0) return undefined;
            const v = argv[i + 1];
            if (!v || v.startsWith("--"))
              throw new Error(`${flag} needs a value.`);
            return v;
          };
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              await diagnosticsReport({
                threadId: value("--thread"),
                group: value("--group"),
                titles: argv.includes("--titles"),
              }),
            ),
          };
        }
        if (argv[0] === "cancel")
          return { exitCode: 0, stdout: JSON.stringify(cancel()) };
        if (argv[0] === "organize") {
          if (progress || organizing)
            throw new Error("Busy; try again shortly.");
          await organize(
            undefined,
            undefined,
            (await settings.get()).diagnostics,
          );
          return {
            exitCode: 0,
            stdout: JSON.stringify(log.slice(-50)),
          };
        }
        if (argv[0] === "fixture" && argv[1]) {
          if (progress) throw new Error("An analysis is running.");
          await loadFixture(argv[1] === "off" ? null : absolute(argv[1]));
          return {
            exitCode: 0,
            stdout: JSON.stringify({ fixture: fixture?.path ?? null }),
          };
        }
        if (argv[0] === "export" && argv[1]) {
          if (fixture) throw new Error("Turn fixture replay off first.");
          const warnings: string[] = [];
          const controller = new AbortController();
          const contexts = await collect(
            await inventory(),
            warnings,
            controller.signal,
          );
          await writeFile(absolute(argv[1]), JSON.stringify(contexts, null, 1));
          return {
            exitCode: 0,
            stdout: JSON.stringify({ threads: contexts.length, warnings }),
          };
        }
        return {
          exitCode: 1,
          stderr:
            "Usage: bb workstreams list | analyze [--fresh] [--diagnose] | diagnose [--thread <id>] [--group <name>] [--titles] | cancel | organize | export <path> | fixture <path|off>",
        };
      } catch (e) {
        return {
          exitCode: 1,
          stderr: e instanceof Error ? e.message : String(e),
        };
      }
    },
  });
}
