/**
 * `bb workstreams …` for Tom, scripts, and agents. Output is bounded: lists
 * are capped and titles truncated.
 */
import type { AgentRecaps } from "./recap.ts";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import {
  projectWorkstreams,
  type Group,
  type Section,
} from "../domain/project.ts";
import { relativeAge } from "../domain/presentation.ts";
import { isCurrent } from "../domain/analysis.ts";
import { needsYou, workView } from "../domain/status.ts";
import type { Analyzer, StoredAnalysis } from "./analyzer.ts";
import type { Organizer } from "./organizer.ts";
import type { WorkstreamMap } from "./map.ts";
import {
  listActiveThreads,
  listSections,
  type InventoryThread,
} from "./inventory.ts";
import type { Journal, JournalEntry } from "./journal.ts";
import { UserError, type WorkstreamService } from "./service.ts";
import {
  TRACE_KINDS,
  TRACE_KIND_TITLE,
  type Trace,
  type TraceSummary,
} from "../domain/trace.ts";
import type { TraceStore } from "./trace.ts";
import type { StoredOrder } from "./order.ts";
import type { TopicStore } from "./topics.ts";
import type { Topic, TopicAssignment } from "../domain/topics.ts";
import { topicPath } from "../domain/topic-path.ts";
import { activeHome } from "../domain/regroup.ts";
import type { Prefs } from "../domain/prefs.ts";
import type { Inference } from "./model.ts";

const TITLE_MAX = 80;
const clip = (text: string) =>
  text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1)}…`;

/**
 * Whether a workstream argument names the Unfiled group. `unsorted`, its
 * former name, still works in scripts.
 */
const isUnfiled = (arg: string) =>
  ["unfiled", "unsorted"].includes(arg.trim().toLowerCase());

function resolveWorkstream(sections: Section[], arg: string): Section | null {
  const lowered = arg.trim().toLowerCase();
  return (
    sections.find((s) => s.id === arg) ??
    sections.find((s) => s.name.toLowerCase() === lowered) ??
    null
  );
}

/** How `thread show` names where a thread's topic came from. */
const TOPIC_SOURCE_LABEL = {
  manual: "set by you",
  inherited: "inherited from where the thread started",
  full: "settled by Full analysis",
  quick: "Quick analysis's guess from the first request",
  none: "none yet",
} as const;

function resolveTopic(topics: TopicStore, arg: string): Topic {
  const direct = topics.getById(arg);
  if (direct) return direct;
  const list = topics.list();
  const lowered = arg.trim().toLowerCase();
  const byName = list.find((e) => e.name.toLowerCase() === lowered);
  if (byName) return byName;
  const byAlias = list.find((e) =>
    e.aliases.some((a) => a.toLowerCase() === lowered),
  );
  if (byAlias) return byAlias;
  throw new PluginCliError(`Unknown topic: "${arg}"`, {
    code: "catalog_entity_not_found",
  });
}

function resolveThread(
  service: WorkstreamService,
  arg: string,
): { id: string; title: string; sectionId: string | null } {
  const cleanId = arg.replace(/^@thread:/, "");
  const threads = service.threads();
  const thread = threads.find((t) => t.id === cleanId || t.id === arg);
  if (!thread) {
    throw new PluginCliError(`Unknown thread: "${arg}"`, {
      code: "thread_not_found",
    });
  }
  return thread;
}

function groupJson(group: Group<InventoryThread>, now: number) {
  return {
    id: group.id,
    name: group.name,
    threads: group.total,
    needsYou: group.needsYou,
    lastActive: group.lastActiveAt
      ? relativeAge(group.lastActiveAt, now)
      : null,
    prioritized: group.prioritized,
  };
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** `YYYY-MM-DD HH:MM` in the server's local time zone. */
function localMinute(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function entryLine(entry: JournalEntry): string {
  const when = localMinute(entry.at);
  const status = entry.status === "applied" ? "" : ` [${entry.status}]`;
  return `${when}  ${entry.action.padEnd(17)} ${entry.source.padEnd(8)} ${entry.rationale}${status}  (${entry.id})`;
}

function analysisLine(
  thread: InventoryThread,
  analysis: StoredAnalysis | undefined,
): string {
  if (!analysis) return "not analyzed yet";
  const where = `${analysis.state.replace("_", " ")} — ${analysis.recap}`;
  return isCurrent(analysis, thread) ? where : `pending (was: ${where})`;
}

function traceLine(trace: TraceSummary): string {
  const status = trace.status === "ok" ? "" : ` [${trace.status}]`;
  const seconds = `${(trace.durationMs / 1000).toFixed(1)}s`;
  return `${localMinute(trace.at)}  ${trace.kind.padEnd(15)} ${seconds.padStart(6)}  ${clip(trace.label)}${
    trace.summary ? ` — ${trace.summary}` : ""
  }${status}  (${trace.id})`;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** A whole trace as plain text, in the order a reader debugs it. */
function traceText(trace: Trace): string {
  const section = (title: string, body: string | null) =>
    body ? [`── ${title} ──`, body, ""] : [];
  return [
    `${TRACE_KIND_TITLE[trace.kind]}: ${trace.label}`,
    `${localMinute(trace.at)} · ${trace.model} · ${(trace.durationMs / 1000).toFixed(1)}s · ${trace.status}${
      trace.usage
        ? ` · ${trace.usage.input} in / ${trace.usage.output} out · $${trace.usage.cost.toFixed(4)}`
        : ""
    }${trace.replayOf ? ` · replay of ${trace.replayOf}` : ""}`,
    "",
    ...section("Error", trace.error),
    ...section("Parsed", trace.parsed === null ? null : json(trace.parsed)),
    ...section("Outcome", trace.outcome === null ? null : json(trace.outcome)),
    ...section("Reasoning", trace.reasoning ?? "(none returned)"),
    ...section("Response", trace.response),
    ...section("System prompt", trace.system),
    ...section("Prompt", trace.prompt),
    ...section(
      "Links",
      trace.links.map((l) => `${l.kind} ${l.ref}`).join("\n") || null,
    ),
    ...section("Replays", trace.replays.map(traceLine).join("\n") || null),
  ].join("\n");
}

export function registerCli(
  bb: BbPluginApi,
  {
    service,
    journal,
    analyzer,
    recaps,
    organizer,
    map,
    traces,
    arrangement,
    topics,
    inference,
    currentPrefs,
    notify,
    reclassifyTask,
  }: {
    /** The sidebar's stored order and prioritized workstreams. */
    arrangement: {
      load(): StoredOrder;
      setPrioritized(ids: readonly string[]): void;
    };
    service: WorkstreamService;
    journal: Journal;
    analyzer: Analyzer;
    recaps: AgentRecaps;
    organizer: Organizer;
    map: WorkstreamMap;
    traces: TraceStore;
    topics: TopicStore;
    inference?: Inference;
    currentPrefs?: () => Prefs;
    notify?: () => void;
    reclassifyTask?: (input: {
      threadId: string;
    }) => Promise<{ assignment: TopicAssignment }>;
  },
): void {
  const load = async () => {
    const [threads, sections] = await Promise.all([
      listActiveThreads(bb.sdk),
      listSections(bb.sdk),
    ]);
    const now = Date.now();
    const analyzed = analyzer.all();
    const reported = recaps.all();
    // Status follows the shared rule: the agent's recap outranks analysis.
    const work = new Map(
      threads.map((thread) => [
        thread.id,
        workView(thread, analyzed[thread.id], reported[thread.id]),
      ]),
    );
    const analysis: Record<string, StoredAnalysis> = { ...analyzed };
    for (const [threadId, view] of work)
      if (view.kind === "current") analysis[threadId] = view.analysis;
    return {
      now,
      sections,
      threads,
      analysis,
      projection: projectWorkstreams(threads, sections, {
        now,
        needsYou: (thread) => needsYou(thread, work.get(thread.id)!),
        order: arrangement.load(),
      }),
    };
  };
  const fail = (error: unknown): never => {
    if (error instanceof UserError)
      throw new PluginCliError(error.message, { code: "workstreams_error" });
    throw error;
  };

  bb.cli.register(
    defineCli({
      name: "workstreams",
      summary:
        "List workstreams and their threads, manage topics, and read the activity log",
      commands: {
        list: cliCommand({
          summary: "List workstreams (native BB sections) with thread counts",
          options: {
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ options }) {
            const { now, projection } = await load();
            const active = projection.groups.map((g) => groupJson(g, now));
            const unsorted = groupJson(projection.unsorted, now);
            const dormant = projection.dormant.map((g) => groupJson(g, now));
            if (options.json)
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  { workstreams: active, unsorted, dormant },
                  null,
                  2,
                ),
              };
            const line = (g: ReturnType<typeof groupJson>) =>
              `${g.name.padEnd(36)} ${plural(g.threads, "thread").padStart(11)}${g.needsYou ? ` · ${g.needsYou} up next` : ""}${g.lastActive ? ` · ${g.lastActive}` : ""}${g.prioritized ? " · prioritized" : ""}  (${g.id})`;
            const lines = [
              ...active.map(line),
              line(unsorted),
              ...(dormant.length
                ? ["", `Dormant: ${dormant.map((g) => g.name).join(", ")}`]
                : []),
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        show: cliCommand({
          summary: "Show the threads in one workstream, nested by parent",
          positionals: [
            {
              name: "workstream",
              description:
                "Workstream name or section id; `unfiled` for threads in no workstream",
              required: true,
            },
          ],
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run({ positionals, options }) {
            const { now, sections, projection, analysis } = await load();
            const arg = positionals.workstream;
            const group = isUnfiled(arg)
              ? projection.unsorted
              : (() => {
                  const section = resolveWorkstream(sections, arg);
                  if (!section)
                    throw new PluginCliError(`No workstream named "${arg}".`, {
                      code: "workstream_not_found",
                      hint: "Run `bb workstreams list` to see workstream names and ids.",
                    });
                  return [...projection.groups, ...projection.dormant].find(
                    (g) => g.id === section.id,
                  )!;
                })();
            const rows = group.rows.slice(0, 200);
            if (options.json)
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  {
                    ...groupJson(group, now),
                    rows: rows.map((r) => ({
                      id: r.thread.id,
                      title: clip(r.thread.title),
                      depth: r.depth,
                      status: r.thread.status,
                      needsYou: r.needsYou,
                      lastActive: relativeAge(r.thread.latestAttentionAt, now),
                      analysis: analysis[r.thread.id] ?? null,
                      current: isCurrent(analysis[r.thread.id], r.thread),
                    })),
                  },
                  null,
                  2,
                ),
              };
            const lines = rows.flatMap((r) => {
              const indent = "  ".repeat(Math.min(r.depth, 4));
              return [
                `${indent}${r.needsYou ? "? " : ""}${clip(r.thread.title)}  · ${relativeAge(r.thread.latestAttentionAt, now)}  (${r.thread.id})`,
                `${indent}    ${analysisLine(r.thread, analysis[r.thread.id])}`,
              ];
            });
            return {
              exitCode: 0,
              stdout: [
                `${group.name} — ${plural(group.total, "thread")}`,
                ...lines,
              ].join("\n"),
            };
          },
        }),
        log: cliCommand({
          summary:
            "Show the activity log: every change Workstreams made or observed",
          options: {
            limit: {
              type: "integer",
              min: 1,
              max: 500,
              default: 50,
              description: "Entries to show (1-500)",
            },
            since: {
              type: "duration",
              defaultUnit: "h",
              description: "Only entries newer than this (e.g. 90m, 7d)",
            },
            external: {
              type: "boolean",
              description: "Include changes made outside Workstreams",
            },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ options }) {
            const cutoff = options.since ? Date.now() - options.since : 0;
            const entries = journal
              .list({ limit: options.limit, external: options.external })
              .filter((e) => e.at >= cutoff);
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify({ entries }, null, 2)
                : entries.length
                  ? entries.map(entryLine).join("\n")
                  : "No activity.",
            };
          },
        }),
        analyze: cliCommand({
          summary:
            "Analyze one thread now, or queue every thread whose latest turn isn't analyzed yet",
          positionals: [
            {
              name: "thread",
              description: "Thread id; omit to catch up on all threads",
            },
          ],
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run({ positionals, options }) {
            if (positionals.thread) {
              const started = Date.now();
              const result = await analyzer
                .analyzeNow(positionals.thread)
                .catch((error: unknown) => {
                  throw new PluginCliError(
                    error instanceof Error ? error.message : String(error),
                    { code: "analysis_failed" },
                  );
                });
              if (!result)
                throw new PluginCliError(
                  "That thread is archived or hidden, so it isn't analyzed.",
                  { code: "not_analyzable" },
                );
              const seconds = ((Date.now() - started) / 1000).toFixed(1);
              return {
                exitCode: 0,
                stdout: options.json
                  ? JSON.stringify({ ...result, seconds }, null, 2)
                  : [
                      `${result.state.replace("_", " ")}${result.reported ? " (reported)" : ""} · ${seconds}s · ${result.model}`,
                      result.recap,
                      ...(result.goal ? [`Goal: ${result.goal}`] : []),
                      `Topic: ${topics.assignment(positionals.thread).label ?? "none"}`,
                      ...(result.needsYou
                        ? [`Up Next: ${result.needsYou}`]
                        : []),
                    ].join("\n"),
              };
            }
            const queued = analyzer.catchUp(await listActiveThreads(bb.sdk));
            const message = `Queued ${plural(queued, "thread")} for analysis.${analyzer.lastError ? ` Last error: ${analyzer.lastError}` : ""}`;
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify({ queued, lastError: analyzer.lastError })
                : message,
            };
          },
        }),
        organization: cliCommand({
          summary:
            "Show how threads are organized into workstreams, or organize them again now",
          options: {
            rebuild: {
              type: "boolean",
              description:
                "Run an organizer pass now, and retry one that failed",
            },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ options }) {
            const state = options.rebuild
              ? await organizer.rebuild().catch(fail)
              : organizer.state();
            const coverage = analyzer.coverage();
            if (options.json)
              return {
                exitCode: state.status === "failed" ? 1 : 0,
                stdout: JSON.stringify({ ...state, coverage }, null, 2),
              };
            const lines = [
              `Status: ${state.status}${state.error ? ` (${state.error})` : ""}`,
              `Workstreams: ${state.groups.length}`,
              `Active threads: ${state.counts.activeRoots}, done: ${state.counts.completedRoots}, no topic: ${state.counts.unresolvedRoots}`,
              `Agent reports: ${coverage.reported} of ${coverage.analyzed} analyzed latest turns`,
              ...state.groups.map(
                (g) =>
                  `  ${g.name} (${plural(g.totalCount, "thread")}: ${g.activeCount} active, ${g.completedCount} done)`,
              ),
            ];
            return {
              exitCode: state.status === "failed" ? 1 : 0,
              stdout: lines.join("\n"),
            };
          },
        }),
        trace: cliCommand({
          summary:
            "Show recorded model calls (Debug mode): one in full, or the latest",
          positionals: [
            {
              name: "id",
              description: "Trace id; omit to list the latest calls",
            },
          ],
          options: {
            thread: {
              type: "string",
              description: "Only calls about this thread",
            },
            entry: {
              type: "string",
              description: "Only calls behind this activity log entry",
            },
            kind: {
              type: "string",
              description: `Only this kind: ${TRACE_KINDS.join(", ")}`,
            },
            limit: {
              type: "integer",
              min: 1,
              max: 500,
              default: 20,
              description: "Calls to list (1-500)",
            },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ positionals, options }) {
            if (positionals.id) {
              const trace = traces.get(positionals.id);
              if (!trace)
                throw new PluginCliError("No model call with that id.", {
                  code: "trace_not_found",
                  hint: "Run `bb workstreams trace` to list recorded calls.",
                });
              return {
                exitCode: 0,
                stdout: options.json ? json(trace) : traceText(trace),
              };
            }
            const kind = options.kind
              ? TRACE_KINDS.find((k) => k === options.kind)
              : undefined;
            if (options.kind && !kind)
              throw new PluginCliError(`Unknown kind "${options.kind}".`, {
                code: "unknown_kind",
                hint: `Kinds: ${TRACE_KINDS.join(", ")}`,
              });
            const list = traces.list({
              kind,
              limit: options.limit,
              link: options.thread
                ? { kind: "thread", ref: options.thread }
                : options.entry
                  ? { kind: "entry", ref: options.entry }
                  : undefined,
            });
            return {
              exitCode: 0,
              stdout: options.json
                ? json({ traces: list })
                : list.length
                  ? list.map(traceLine).join("\n")
                  : "No model calls recorded. Debug mode records them: `bb plugin config workstreams set debug true`.",
            };
          },
        }),
        undo: cliCommand({
          summary: "Undo a logged change, where BB state still allows it",
          positionals: [
            {
              name: "entry",
              description: "Activity log entry id",
              required: true,
            },
          ],
          async run({ positionals }) {
            const entry = await service.undo(positionals.entry).catch(fail);
            return {
              exitCode: 0,
              stdout: `${entry.rationale}${entry.detail ? ` (${entry.detail})` : ""}`,
            };
          },
        }),
        "topics list": cliCommand({
          summary: "List all topics",
          options: {
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ options }) {
            const entities = topics.list();
            if (options.json) {
              const items = entities.map((e) => ({
                id: e.id,
                name: e.name,
                description: e.description,
                parentId: e.parentId,
                aliases: e.aliases,
                path: topicPath(e.id, entities),
              }));
              return {
                exitCode: 0,
                stdout: JSON.stringify({ entities: items }, null, 2),
              };
            }
            if (entities.length === 0) {
              return { exitCode: 0, stdout: "No topics yet." };
            }
            const sorted = [...entities].sort((a, b) =>
              topicPath(a.id, entities).localeCompare(
                topicPath(b.id, entities),
              ),
            );
            const lines = sorted.map((e) => {
              const label = topicPath(e.id, entities);
              const aliases =
                e.aliases.length > 0
                  ? ` [aliases: ${e.aliases.join(", ")}]`
                  : "";
              return `${label.padEnd(40)} ${e.id}${aliases}`;
            });
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        "topics show": cliCommand({
          summary: "Show a topic's details",
          positionals: [
            {
              name: "topic",
              description: "Topic name or ID",
              required: true,
            },
          ],
          options: {
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ positionals, options }) {
            const entity = resolveTopic(topics, positionals.topic);
            const entities = topics.list();
            const label = topicPath(entity.id, entities);
            const groups = topics.groups();
            const home = activeHome(entity.id, [...groups.values()], entities);
            const assignments = topics.assignments();
            const assignedThreads = (
              Object.values(assignments) as TopicAssignment[]
            ).filter((a) => a.entityId === entity.id);
            if (options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  {
                    entity,
                    path: label,
                    homeEntityId: home,
                    assignedThreads: assignedThreads.map((a) => a.threadId),
                  },
                  null,
                  2,
                ),
              };
            }
            const lines = [
              `Topic: ${label}`,
              `ID:              ${entity.id}`,
              `Description:     ${entity.description || "(none)"}`,
              `Parent:          ${entity.parentId ?? "(root)"}`,
              `Aliases:         ${entity.aliases.length ? entity.aliases.join(", ") : "(none)"}`,
              `Assigned tasks:  ${assignedThreads.length}`,
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        "topics create": cliCommand({
          summary: "Create a topic",
          positionals: [
            {
              name: "name",
              description: "Topic name",
              required: true,
            },
          ],
          options: {
            description: {
              type: "string",
              description: "Description of scope",
            },
            parent: {
              type: "string",
              description: "Parent topic name or ID",
            },
            aliases: {
              type: "string",
              description: "Comma-separated aliases",
            },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ positionals, options }) {
            let parentId: string | null = null;
            if (options.parent) {
              const parent = resolveTopic(topics, options.parent);
              parentId = parent.id;
            }
            const aliases = options.aliases
              ? options.aliases
                  .split(",")
                  .map((a) => a.trim())
                  .filter(Boolean)
              : [];
            try {
              const entity = topics.create(
                positionals.name,
                options.description ?? "",
                parentId,
                aliases,
              );
              notify?.();
              organizer.trigger();
              if (options.json) {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({ entity }, null, 2),
                };
              }
              return {
                exitCode: 0,
                stdout: `Created topic "${entity.name}" (${entity.id}).`,
              };
            } catch (err) {
              throw new PluginCliError(
                err instanceof Error ? err.message : String(err),
                { code: "catalog_create_failed" },
              );
            }
          },
        }),
        "topics edit": cliCommand({
          summary: "Edit a topic's name, description, or aliases",
          positionals: [
            {
              name: "topic",
              description: "Topic name or ID to edit",
              required: true,
            },
          ],
          options: {
            name: { type: "string", description: "New name" },
            description: { type: "string", description: "New description" },
            aliases: {
              type: "string",
              description: "New comma-separated aliases",
            },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ positionals, options }) {
            const entity = resolveTopic(topics, positionals.topic);
            try {
              const updated = topics.edit(entity.id, {
                name: options.name,
                description: options.description,
                aliases:
                  options.aliases !== undefined
                    ? options.aliases
                        .split(",")
                        .map((a) => a.trim())
                        .filter(Boolean)
                    : undefined,
              });
              notify?.();
              organizer.trigger();
              if (options.json) {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({ entity: updated }, null, 2),
                };
              }
              return {
                exitCode: 0,
                stdout: `Updated topic "${updated.name}" (${updated.id}).`,
              };
            } catch (err) {
              throw new PluginCliError(
                err instanceof Error ? err.message : String(err),
                { code: "catalog_edit_failed" },
              );
            }
          },
        }),
        "topics reparent": cliCommand({
          summary: "Move a topic under a different parent",
          positionals: [
            {
              name: "topic",
              description: "Topic name or ID to move",
              required: true,
            },
          ],
          options: {
            to: {
              type: "string",
              description:
                'New parent topic name or ID, or "root" for top-level',
            },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ positionals, options }) {
            const entity = resolveTopic(topics, positionals.topic);
            let newParentId: string | null = null;
            if (options.to && options.to.toLowerCase() !== "root") {
              const parent = resolveTopic(topics, options.to);
              newParentId = parent.id;
            }
            try {
              const updated = topics.reparent(entity.id, newParentId);
              notify?.();
              organizer.trigger();
              if (options.json) {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({ entity: updated }, null, 2),
                };
              }
              const targetName = newParentId
                ? (topics.getById(newParentId)?.name ?? newParentId)
                : "root";
              return {
                exitCode: 0,
                stdout: `Reparented "${updated.name}" to ${targetName} (${updated.id}).`,
              };
            } catch (err) {
              throw new PluginCliError(
                err instanceof Error ? err.message : String(err),
                { code: "catalog_reparent_failed" },
              );
            }
          },
        }),
        "topics merge": cliCommand({
          summary:
            "Merge a topic into another, moving its threads and subtopics",
          positionals: [
            {
              name: "source",
              description: "Topic name or ID to merge",
              required: true,
            },
            {
              name: "target",
              description: "Topic name or ID to merge into",
              required: true,
            },
          ],
          options: {
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ positionals, options }) {
            const source = resolveTopic(topics, positionals.source);
            const target = resolveTopic(topics, positionals.target);
            try {
              const result = topics.merge(source.id, target.id);
              notify?.();
              organizer.trigger();
              if (options.json) {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({ entity: result }, null, 2),
                };
              }
              return {
                exitCode: 0,
                stdout: `Merged "${source.name}" into "${target.name}" (${result.target.id}).`,
              };
            } catch (err) {
              throw new PluginCliError(
                err instanceof Error ? err.message : String(err),
                { code: "catalog_merge_failed" },
              );
            }
          },
        }),
        "thread show": cliCommand({
          summary:
            "Show a thread's topic, where it came from, and its workstream",
          positionals: [
            {
              name: "thread",
              description: "Thread ID",
              required: true,
            },
          ],
          options: {
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ positionals, options }) {
            await service.reconcile();
            const thread = resolveThread(service, positionals.thread);
            const assignment = topics.assignment(thread.id);
            const rootId = topics.findRootThread(thread.id);
            const rootThread =
              rootId !== thread.id
                ? service.threads().find((t) => t.id === rootId)
                : thread;
            const effectiveSectionId =
              rootThread?.sectionId ?? thread.sectionId;
            const sectionName = effectiveSectionId
              ? (map.get(effectiveSectionId)?.name ?? effectiveSectionId)
              : "Unfiled";
            if (options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  {
                    threadId: thread.id,
                    title: thread.title,
                    sectionId: thread.sectionId,
                    workstream: sectionName,
                    assignment,
                  },
                  null,
                  2,
                ),
              };
            }
            const lines = [
              `Thread:          ${clip(thread.title)} (@thread:${thread.id})`,
              `Workstream:      ${sectionName}`,
              `Topic:           ${assignment.label ?? "none"}`,
              `Source:          ${TOPIC_SOURCE_LABEL[assignment.provenance ?? "none"]}`,
              ...(assignment.inheritedFrom
                ? [`Follows parent:  @thread:${assignment.inheritedFrom}`]
                : []),
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        "thread assign": cliCommand({
          summary:
            "Set a thread's topic yourself; Workstreams then leaves it alone",
          positionals: [
            {
              name: "thread",
              description: "Thread ID",
              required: true,
            },
            {
              name: "topic",
              description: "Topic name or ID",
              required: true,
            },
          ],
          options: {
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ positionals, options }) {
            await service.reconcile();
            const thread = resolveThread(service, positionals.thread);
            const entity = resolveTopic(topics, positionals.topic);
            const assignment = topics.assign(thread.id, entity.id, {
              provenance: "manual",
            });
            notify?.();
            organizer.trigger();
            if (options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ assignment }, null, 2),
              };
            }
            return {
              exitCode: 0,
              stdout: `Assigned @thread:${thread.id} to "${entity.name}" (${assignment.label}).`,
            };
          },
        }),
        "thread clear": cliCommand({
          summary:
            "Set a thread to have no topic yourself, so it stays Unfiled",
          positionals: [
            {
              name: "thread",
              description: "Thread ID",
              required: true,
            },
          ],
          options: {
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ positionals, options }) {
            await service.reconcile();
            const thread = resolveThread(service, positionals.thread);
            const assignment = topics.assign(thread.id, null, {
              provenance: "manual",
            });
            notify?.();
            organizer.trigger();
            if (options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ assignment }, null, 2),
              };
            }
            return {
              exitCode: 0,
              stdout: `@thread:${thread.id} has no topic now, and stays Unfiled.`,
            };
          },
        }),
        "thread reclassify": cliCommand({
          summary:
            "Hand a thread's topic back to Workstreams and settle it now with Full analysis",
          positionals: [
            {
              name: "thread",
              description: "Thread ID",
              required: true,
            },
          ],
          options: {
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ positionals, options }) {
            await service.reconcile();
            const thread = resolveThread(service, positionals.thread);
            if (!reclassifyTask) {
              throw new PluginCliError(
                "Inference is unavailable for reclassification.",
                { code: "inference_unavailable" },
              );
            }
            const { assignment } = await reclassifyTask({
              threadId: thread.id,
            }).catch((error: unknown) => {
              throw new PluginCliError(
                error instanceof Error ? error.message : String(error),
                { code: "reclassify_failed" },
              );
            });
            if (options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ assignment }, null, 2),
              };
            }
            return {
              exitCode: 0,
              stdout: `@thread:${thread.id}'s topic is now ${assignment.label ?? "none"}.`,
            };
          },
        }),
      },
    }),
  );
}
