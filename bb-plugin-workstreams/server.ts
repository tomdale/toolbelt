import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BATCH_SIZE,
  analysisSchema,
  snapshotSchema,
  fixtureSchema,
  knownGroups,
  classifyBatch,
  normalizeGroups,
  mapConcurrent,
  type Analysis,
  type Classification,
  type Snapshot,
  type Thread,
  type Context,
} from "./model";
import { redact } from "./redact";
import { hostContract } from "./host-contract";
import { contextExcerpt, initialRequest } from "./context";

export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: snapshotSchema },
  analyze: { input: z.null(), output: z.object({ ok: z.boolean() }) },
  cancel: { input: z.null(), output: z.object({ ok: z.boolean() }) },
});

function absolute(path: string): string {
  if (!isAbsolute(path)) throw new Error("Use an absolute path.");
  return path;
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
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
    analysis = analysisSchema.nullable().parse(get(analysisKey()));
    error = null;
    notify();
  };
  let analysis: Analysis | null = null;
  let progress: Snapshot["progress"] = null;
  let error: string | null = null;
  let pending = false;
  let run: AbortController | null = null;
  const inference = bb.hosts.experimental_client({ contract: hostContract });
  const settings = bb.settings.define({
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
  analysis ??= analysisSchema.nullable().parse(get(analysisKey()));
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
          t.originPluginId === bb.pluginId
        )
          continue;
        const project = byId.get(t.projectId);
        threads.push({
          id: t.id,
          title: t.title ?? t.titleFallback ?? "Untitled thread",
          project: project?.name ?? "Unknown project",
          repository: project?.gitRemoteUrl ?? null,
          status: t.runtime.displayStatus,
          updatedAt: t.updatedAt,
        });
      }
      if (page.length < 100) break;
    }
    return [...new Map(threads.map((t) => [t.id, t])).values()];
  }
  /** Reads bounded, attributed conversation context for each thread. */
  async function collect(
    threads: Thread[],
    warnings: string[],
    signal: AbortSignal,
    onRead: () => void = () => {},
  ): Promise<Context[]> {
    return mapConcurrent(threads, async (thread): Promise<Context> => {
      signal.throwIfAborted();
      let initial = "";
      let prompts: Awaited<ReturnType<typeof bb.sdk.threads.promptHistory>> =
        [];
      let report: string | null = null;
      let path: string | null = null;
      try {
        initial = initialRequest(
          await bb.sdk.threads.events.list({
            threadId: thread.id,
            types: ["client/turn/requested"],
            order: "asc",
            limit: "3",
            signal,
          }),
        );
      } catch {
        signal.throwIfAborted();
        warnings.push(
          `Could not read the initial request for ${thread.title}.`,
        );
      }
      try {
        prompts = await bb.sdk.threads.promptHistory({
          threadId: thread.id,
          limit: "3",
          signal,
        });
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
    };
    const complete = async (prompt: string, hostId: string) => {
      signal.throwIfAborted();
      stats.calls++;
      const { text, usage } = await inference.call(
        "complete",
        { prompt },
        { hostId, signal, timeoutMs: 130_000 },
      );
      stats.inputTokens += usage.input;
      stats.outputTokens += usage.output;
      stats.cost += usage.cost;
      return redact(text);
    };
    const threads = await inventory(signal);
    if (!threads.length) {
      analysis = { at: Date.now(), items: [], warnings: [] };
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
    // Seeding earlier names keeps product labels stable across runs and batches.
    const seed = knownGroups(analysis);
    const kept: Analysis["items"] = [];
    const items = (
      await mapConcurrent(batches, async (batch) => {
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
        classified += batch.length;
        advance("classifying", classified, threads.length);
        return result;
      })
    ).flat();
    signal.throwIfAborted();
    if (!items.length && batches.length)
      throw new Error(
        "Classification failed for every thread. Previous results are unchanged.",
      );
    const timestamps = new Map(threads.map((t) => [t.id, t.updatedAt]));
    stats.seconds = Math.round((Date.now() - started) / 100) / 10;
    stats.cost = Math.round(stats.cost * 10000) / 10000;
    analysis = {
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
      stats,
    };
    put(analysisKey(), analysis);
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
  const start = () => {
    if (progress) throw new Error("An analysis is already running.");
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
  const snapshot = async (): Promise<Snapshot> => ({
    threads: await inventory(),
    analysis,
    progress,
    error,
    fixture: fixture ? basename(fixture.path) : null,
  });
  bb.rpc.register(rpcContract, {
    snapshot,
    analyze: async () => start(),
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
        usage: "bb workstreams analyze",
      },
      {
        name: "cancel",
        summary: "Cancel a running analysis",
        usage: "bb workstreams cancel",
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
          return { exitCode: 0, stdout: JSON.stringify(start()) };
        if (argv[0] === "cancel")
          return { exitCode: 0, stdout: JSON.stringify(cancel()) };
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
            "Usage: bb workstreams list | analyze | cancel | export <path> | fixture <path|off>",
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
