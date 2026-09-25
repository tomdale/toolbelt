import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BATCH_SIZE,
  analysisSchema,
  snapshotSchema,
  UNCLASSIFIED,
  fixtureSchema,
  classifyBatch,
  normalizeGroups,
  applyDrift,
  mapConcurrent,
  type Analysis,
  type Classification,
  type Drift,
  type Snapshot,
  type Thread,
  type Context,
} from "./model";
import { redact } from "./redact";
import { detectDrift } from "./drift";
import {
  IMAGE_MODEL,
  bannerCacheSignature,
  bannerKey,
  bannerMotif,
  bannerNeedsRegeneration,
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
  planOrganize,
  type Action,
  type LogEntry,
} from "./organize";
import { hostContract } from "./host-contract";
import {
  contextExcerpt,
  initialRequest,
  inputText,
  requestTimeline,
} from "./context";

const viewSchema = snapshotSchema.extend({
  log: z.array(logEntrySchema),
  /** Banner image URL by group name, for groups that have one. */
  banners: z.record(z.string(), z.string()),
  mode: z.enum(["auto", "suggest"]),
  organizing: z.boolean(),
});
export type View = z.infer<typeof viewSchema>;
const threadInput = z.object({ threadId: z.string() });
const ok = z.object({ ok: z.boolean() });
export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: viewSchema },
  /** Analysis only, for the sidebar, which reads threads from BB's live view. */
  sidebar: {
    input: z.null(),
    output: z.object({
      analysis: analysisSchema.nullable(),
      banners: z.record(z.string(), z.string()),
    }),
  },
  organize: { input: z.null(), output: ok },
  split: { input: threadInput, output: ok },
  undo: { input: z.object({ id: z.string() }), output: ok },
  analyze: { input: z.null(), output: z.object({ ok: z.boolean() }) },
  cancel: { input: z.null(), output: z.object({ ok: z.boolean() }) },
});

export const SPLIT_NOTE = "Workstreams split this thread";
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
    analysis = analysisSchema.nullable().catch(null).parse(get(analysisKey()));
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
  });
  const notify = () => bb.realtime.publish("changed", {});
  try {
    const saved = get("fixture");
    if (typeof saved === "string") await loadFixture(saved);
  } catch {
    put("fixture", null);
  }
  analysis ??= analysisSchema.nullable().catch(null).parse(get(analysisKey()));
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
          (t.originPluginId === bb.pluginId && t.originKind !== "fork")
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
          updatedAt: t.updatedAt,
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
    const pinned = new Map<string, string>();
    for (const e of splits())
      if (e.action.kind === "split") {
        pinned.set(e.action.threadId, e.action.drift.to);
        if (e.undo?.forkId) pinned.set(e.undo.forkId, e.action.drift.from);
      }
    const previous = new Map(
      (analysis?.items ?? [])
        .filter((i) => i.group !== UNCLASSIFIED)
        .map((i) => [i.threadId, i.group]),
    );
    // A thread the user moved to another section in BB's sidebar keeps that
    // section as its group: moving a thread is how groups are corrected.
    const assigned = new Map<string, string>();
    for (const e of log)
      if (e.action.kind === "section" && e.result === "done" && !e.undone)
        assigned.set(e.action.threadId, e.action.section);
    const names = new Map(
      (await bb.sdk.threadSections.list()).map((s) => [s.id, s.name]),
    );
    for (const t of threads) {
      const section = t.sectionId ? names.get(t.sectionId) : undefined;
      // A section name is the user's visible grouping choice. Renaming a
      // section or moving a thread into one is an explicit correction; use it
      // as this thread's pinned workstream on future classifications.
      if (section) pinned.set(t.id, section);
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
        // First and latest 100 requests: long threads keep both the opening
        // intent and the recent history where side quests usually start.
        const query = {
          threadId: thread.id,
          types: ["client/turn/requested"] as ["client/turn/requested"],
          limit: "100",
          signal,
        };
        const [head, tail] = await Promise.all([
          bb.sdk.threads.events.list({ ...query, order: "asc" }),
          bb.sdk.threads.events.list({ ...query, order: "desc" }),
        ]);
        const since = splitAt.get(thread.id) ?? 0;
        const events = [
          ...new Map(
            [...head, ...tail.reverse()].map((e) => [e.seq, e]),
          ).values(),
        ]
          .sort((a, b) => a.seq - b.seq)
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
        pinnedGroup: pinned.get(thread.id),
        previousGroup: freshRun ? undefined : previous.get(thread.id),
      };
    });
  }
  async function analyze(signal: AbortSignal) {
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
      analysis = { at: Date.now(), items: [], warnings: [], summaries: {} };
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
    const prior = new Map(analysis?.items.map((i) => [i.threadId, i]));
    // Seeding earlier names was evaluated (eval/README.md) and increased wrong
    // merges without improving accuracy, so each run names groups afresh.
    const seed: string[] = [];
    const kept: Analysis["items"] = [];
    const items = (
      await mapConcurrent(batches, async (batch) => {
        // Drift detection is a separate small call per batch, run alongside.
        const drifts = detectDrift(batch, (prompt) =>
          complete(prompt, host.id),
        ).catch(() => {
          signal.throwIfAborted();
          stats.failedCalls++;
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
            );
          } catch {
            signal.throwIfAborted();
            stats.failedCalls++;
          }
        }
        if (!result.length) {
          warnings.push(
            `Could not classify ${batch.length} threads; earlier results are shown where available.`,
          );
          for (const t of batch) {
            const old = prior.get(t.id);
            if (old) kept.push({ ...old, refreshed: false });
          }
        }
        const found = await drifts;
        classified += batch.length;
        advance("classifying", classified, threads.length);
        return result.map((item) =>
          applyDrift({ ...item, drift: found.get(item.threadId) ?? null }),
        );
      })
    ).flat();
    signal.throwIfAborted();
    if (!items.length && batches.length)
      throw new Error(
        "Classification failed for every thread. Previous results are unchanged.",
      );
    const timestamps = new Map(threads.map((t) => [t.id, t.updatedAt]));
    const next: Analysis = {
      at: Date.now(),
      items: [
        ...normalizeGroups(items).map((i) => ({
          ...i,
          updatedAt: timestamps.get(i.threadId)!,
          refreshed: true,
        })),
        ...kept,
      ],
      warnings,
      summaries: {},
    };
    try {
      const input = summaryInput(next);
      if (input.length) {
        const summaryStarted = Date.now();
        // One group per call avoids truncated or incomplete multi-group JSON
        // from the fast model and makes a single failure local to one summary.
        const summaries = await mapConcurrent(
          input.map((group) => [group]),
          async (batch) => {
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                return parseSummaries(
                  await complete(summaryPrompt(batch), host.id, "summary"),
                  batch.map((g) => g.name),
                );
              } catch {
                signal.throwIfAborted();
              }
            }
            // A bad summary response must not discard classifications or the
            // summaries already saved for this group.
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
    stats.seconds = Math.round((Date.now() - started) / 100) / 10;
    stats.cost = Math.round(stats.cost * 10000) / 10000;
    stats.summaryCost = Math.round(stats.summaryCost * 10000) / 10000;
    analysis = { ...next, stats };
    put(analysisKey(), analysis);
  }
  const logKey = () => (fixture ? "fixture-organize-log" : "organize-log");
  let log: LogEntry[] = z
    .array(logEntrySchema)
    .catch([])
    .parse(get(logKey()) ?? []);
  let organizing = false;
  const record = (entry: Omit<LogEntry, "id" | "at" | "undone">) => {
    log.push({
      ...entry,
      id: crypto.randomUUID(),
      at: Date.now(),
      undone: false,
    });
    log = log.slice(-500);
    put(logKey(), log);
  };
  async function sectionIds() {
    const sections = await bb.sdk.threadSections.list();
    const byName = new Map(sections.map((s) => [s.name.toLowerCase(), s.id]));
    const names = new Map(sections.map((s) => [s.id, s.name]));
    return {
      names,
      list: async () => names,
      async ensure(name: string) {
        const existing = byName.get(name.toLowerCase());
        if (existing) return existing;
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
  ): Promise<Pick<LogEntry, "detail" | "undo">> {
    if (action.kind === "removeSection") {
      await bb.sdk.threadSections.delete({ id: action.sectionId });
      return { detail: "", undo: {} };
    }
    const detail = await bb.sdk.threads.get({ threadId: action.threadId });
    if (detail.archivedAt !== null || detail.deletedAt !== null)
      throw new Error("Thread is archived or deleted.");
    const before = {
      title: detail.title,
      sectionId: detail.sectionId,
      sectionName: detail.sectionId
        ? ((await sections.list()).get(detail.sectionId) ?? null)
        : null,
    };
    if (action.kind === "retitle") {
      await bb.sdk.threads.update({
        threadId: action.threadId,
        title: action.title,
      });
      return { detail: "", undo: before };
    }
    if (action.kind === "section") {
      const sectionId = await sections.ensure(action.section);
      await bb.sdk.threads.update({ threadId: action.threadId, sectionId });
      return { detail: "", undo: before };
    }
    if (detail.status !== "idle" && detail.status !== "error")
      throw new Error("Thread is running; split it when it is idle.");
    const { drift } = action;
    // BB refuses to fork inside turns recorded under another thread's provider
    // session (e.g. delivered manager messages); fall back to earlier turns.
    let fork: Awaited<ReturnType<typeof bb.sdk.threads.fork>> | null = null;
    let lastError: unknown;
    let forkedAt = 0;
    for (const sourceSeqEnd of (
      await mainlineSeqs(action.threadId, drift.splitSeq)
    ).slice(0, 5)) {
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
        lastError = e;
      }
    }
    if (!fork) throw lastError;
    await bb.sdk.threads.update({
      threadId: fork.id,
      sectionId: await sections.ensure(drift.from),
    });
    await bb.sdk.threads.update({
      threadId: action.threadId,
      title: drift.sideTitle,
    });
    let compacted = "compacted";
    try {
      await bb.sdk.threads.compact({ threadId: action.threadId });
    } catch {
      compacted = "not compacted";
    }
    return {
      detail: `New thread ${fork.id} (mainline through #${forkedAt}); original ${compacted}.`,
      undo: { ...before, forkId: fork.id },
    };
  }
  /** Applies actions one at a time; failures are logged and don't stop the pass. */
  async function perform(actions: Action[]) {
    if (fixture) {
      const titles = new Map(fixture.contexts.map((c) => [c.id, c.title]));
      for (const action of actions)
        record({ action, result: "planned", detail: describe(action, titles) });
      notify();
      return;
    }
    const sections = await sectionIds();
    for (const action of actions) {
      try {
        record({
          action,
          result: "done",
          ...(await execute(action, sections)),
        });
      } catch (e) {
        record({
          action,
          result: "failed",
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // The plugin's own edits aren't new work; keep acted-on threads current.
    const fresh = new Map((await inventory()).map((t) => [t.id, t.updatedAt]));
    if (analysis) {
      analysis = {
        ...analysis,
        items: analysis.items.map((i) =>
          actions.some((a) => a.threadId === i.threadId) &&
          fresh.has(i.threadId)
            ? { ...i, updatedAt: fresh.get(i.threadId)! }
            : i,
        ),
      };
      put(analysisKey(), analysis);
    }
    notify();
  }
  /** Sections no active thread uses once threads are filed by workstream. */
  async function emptySections(): Promise<Action[]> {
    const used = new Set((await inventory()).map((t) => t.sectionId));
    return (await bb.sdk.threadSections.list())
      .filter((s) => !used.has(s.id))
      .map((s) => ({
        kind: "removeSection" as const,
        threadId: "" as const,
        section: s.name,
        sectionId: s.id,
      }));
  }
  async function organize() {
    organizing = true;
    notify();
    try {
      const threads = await inventory();
      const sectionNames = fixture
        ? new Map<string, string>()
        : (await sectionIds()).names;
      const namesById = new Map(
        (await bb.sdk.threadSections.list()).map((s) => [s.id, s.name]),
      );
      const renamedByWorkstreams = new Map<string, string>();
      for (const e of log)
        if (e.action.kind === "section" && e.result === "done" && !e.undone)
          renamedByWorkstreams.set(e.action.threadId, e.action.section);
      const split = new Set(
        log
          .filter(
            (e) =>
              e.action.kind === "split" && e.result !== "failed" && !e.undone,
          )
          .map((e) => e.action.threadId),
      );
      const actions = planOrganize(
        threads.map((t) => ({
          ...t,
          sectionName: t.sectionId
            ? (sectionNames.get(t.sectionId) ?? null)
            : null,
        })),
        analysis,
        split,
      ).filter((action) => {
        if (action.kind !== "section") return true;
        const assigned = renamedByWorkstreams.get(action.threadId);
        const actual = threads.find((t) => t.id === action.threadId)?.sectionId;
        const oldName = actual ? namesById.get(actual) : undefined;
        // A single-thread group must still follow an explicit Workstreams
        // correction (e.g. "v0 Dev Environment Provisioning" → "v0").
        // Respect a later manual section move. Do not move the thread away
        // from the last section Workstreams assigned on the next run.
        return !assigned || oldName === assigned || assigned === action.section;
      });
      await perform(actions);
      if (!fixture) await perform(await emptySections());
    } finally {
      organizing = false;
      notify();
    }
  }
  async function undo(id: string) {
    const entry = log.find((e) => e.id === id);
    if (!entry || entry.undone || entry.result !== "done" || !entry.undo)
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
    if (entry.action.kind !== "section" && entry.undo.title !== undefined)
      await bb.sdk.threads.update({ threadId, title: entry.undo.title });
    if (entry.action.kind === "section") {
      let sectionId = entry.undo.sectionId ?? null;
      const exists = sectionId
        ? (await bb.sdk.threadSections.list()).some((s) => s.id === sectionId)
        : false;
      if (!exists && entry.undo.sectionName)
        sectionId = await (await sectionIds()).ensure(entry.undo.sectionName);
      await bb.sdk.threads.update({ threadId, sectionId });
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
    return new Response(new Uint8Array(row.data), {
      headers: {
        "content-type": row.mime,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });
  /** Generates banners for summarized groups that don't have one yet. */
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
        bannerNeedsRegeneration(
          cached.get(bannerKey(name)),
          bannerMotif(name, summary.motif),
        ),
    );
    await mapConcurrent(missing, async ([name, summary]) => {
      try {
        const image = await inference.call(
          "image",
          { prompt: bannerPrompt(name, summary.motif), model: IMAGE_MODEL },
          { hostId, signal, timeoutMs: 120_000 },
        );
        db.prepare(
          "INSERT OR REPLACE INTO banners (key, name, motif, mime, data, cost, at) VALUES (?,?,?,?,?,?,?)",
        ).run(
          bannerKey(name),
          name,
          bannerCacheSignature(bannerMotif(name, summary.motif)),
          image.mime,
          Buffer.from(image.data, "base64"),
          image.cost,
          Date.now(),
        );
        notify();
      } catch {
        signal.throwIfAborted();
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
          try {
            await analyze(AbortSignal.any([signal, run.signal]));
            if ((await settings.get()).organize === "auto") await organize();
            if (lastHost) await ensureBanners(lastHost, signal);
          } catch (e) {
            error = run.signal.aborted
              ? "Analysis cancelled. Previous results are unchanged."
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
  const start = (options: { fresh?: boolean } = {}) => {
    if (progress) throw new Error("An analysis is already running.");
    freshRun = !!options.fresh;
    pending = true;
    error = null;
    advance("reading", 0, 0);
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
  const snapshot = async (): Promise<View> => ({
    threads: await inventory(),
    analysis,
    progress,
    error,
    fixture: fixture ? basename(fixture.path) : null,
    log: log.slice(-100),
    banners: bannerUrls(),
    mode: (await settings.get()).organize === "suggest" ? "suggest" : "auto",
    organizing,
  });
  bb.rpc.register(rpcContract, {
    snapshot,
    analyze: async () => start(),
    sidebar: async () => ({
      analysis: fixture ? null : analysis,
      banners: fixture ? {} : bannerUrls(),
    }),
    organize: async () => {
      if (progress || organizing) throw new Error("Busy; try again shortly.");
      await organize();
      return { ok: true };
    },
    split: async ({ threadId }) => {
      const item = analysis?.items.find((i) => i.threadId === threadId);
      if (!item?.drift) throw new Error("No side quest found for this thread.");
      await perform([
        {
          kind: "split",
          threadId,
          drift: item.drift,
        },
      ]);
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
        usage: "bb workstreams analyze [--fresh]",
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
            stdout: JSON.stringify(start({ fresh: argv[1] === "--fresh" })),
          };
        if (argv[0] === "cancel")
          return { exitCode: 0, stdout: JSON.stringify(cancel()) };
        if (argv[0] === "organize") {
          if (progress || organizing)
            throw new Error("Busy; try again shortly.");
          await organize();
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
            "Usage: bb workstreams list | analyze | cancel | organize | export <path> | fixture <path|off>",
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
