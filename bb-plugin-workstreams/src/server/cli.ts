/**
 * `bb workstreams …` for Tom, scripts, and agents. Output is bounded: lists
 * are capped and titles truncated.
 */
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
import { isCurrent, needsYou } from "../domain/analysis.ts";
import type { Analyzer, StoredAnalysis } from "./analyzer.ts";
import type { Bootstrap, BootstrapState } from "./bootstrap.ts";
import type { WorkstreamMap } from "./map.ts";
import type { RouteDecision, Router } from "./router.ts";
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

const TITLE_MAX = 80;
const clip = (text: string) =>
  text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1)}…`;

function resolveWorkstream(sections: Section[], arg: string): Section | null {
  const lowered = arg.trim().toLowerCase();
  return (
    sections.find((s) => s.id === arg) ??
    sections.find((s) => s.name.toLowerCase() === lowered) ??
    null
  );
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
    bootstrap,
    map,
    router,
    traces,
  }: {
    service: WorkstreamService;
    journal: Journal;
    analyzer: Analyzer;
    bootstrap: Bootstrap;
    map: WorkstreamMap;
    router: Router;
    traces: TraceStore;
  },
): void {
  const load = async () => {
    const [threads, sections] = await Promise.all([
      listActiveThreads(bb.sdk),
      listSections(bb.sdk),
    ]);
    const now = Date.now();
    const analysis = analyzer.all();
    return {
      now,
      sections,
      threads,
      analysis,
      projection: projectWorkstreams(threads, sections, {
        now,
        needsYou: (thread) => needsYou(thread, analysis[thread.id]),
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
        "List workstreams, file threads into them, and read the activity log",
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
              `${g.name.padEnd(36)} ${plural(g.threads, "thread").padStart(11)}${g.needsYou ? ` · ${g.needsYou} need you` : ""}${g.lastActive ? ` · ${g.lastActive}` : ""}  (${g.id})`;
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
                "Workstream name or section id; `unsorted` for unsectioned threads",
              required: true,
            },
          ],
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run({ positionals, options }) {
            const { now, sections, projection, analysis } = await load();
            const arg = positionals.workstream;
            const group =
              arg.toLowerCase() === "unsorted"
                ? projection.unsorted
                : (() => {
                    const section = resolveWorkstream(sections, arg);
                    if (!section)
                      throw new PluginCliError(
                        `No workstream named "${arg}".`,
                        {
                          code: "workstream_not_found",
                          hint: "Run `bb workstreams list` to see workstream names and ids.",
                        },
                      );
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
        file: cliCommand({
          summary: "File a root thread (and its children) under a workstream",
          positionals: [
            { name: "thread", description: "Thread id", required: true },
            {
              name: "workstream",
              description:
                "Workstream name or section id; `unsorted` to remove it from any workstream",
              required: true,
            },
          ],
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run({ positionals, options }) {
            const sections = await listSections(bb.sdk);
            const target =
              positionals.workstream.toLowerCase() === "unsorted"
                ? null
                : resolveWorkstream(sections, positionals.workstream);
            if (
              target === null &&
              positionals.workstream.toLowerCase() !== "unsorted"
            )
              throw new PluginCliError(
                `No workstream named "${positionals.workstream}".`,
                {
                  code: "workstream_not_found",
                  hint: "Run `bb workstreams list` to see workstream names and ids.",
                },
              );
            const entry = await service
              .move(positionals.thread, target?.id ?? null, "user")
              .catch(fail);
            const message = entry
              ? entry.rationale
              : "Already there; nothing changed.";
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify({ changed: entry !== null, entry }, null, 2)
                : message,
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
                      `${result.state.replace("_", " ")} · ${result.subject ?? "no subject"} · ${seconds}s · ${result.model}`,
                      result.recap,
                      ...(result.needsYou
                        ? [`Needs you: ${result.needsYou}`]
                        : []),
                      ...(result.drift
                        ? [
                            `Drift (${result.drift.confidence}): ${result.drift.workstream ?? result.drift.newName}`,
                          ]
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
        edit: cliCommand({
          summary:
            "Edit a workstream's description or aliases; your description always wins over a generated one",
          positionals: [
            {
              name: "workstream",
              description: "Workstream name or section id",
              required: true,
            },
          ],
          options: {
            description: {
              type: "string",
              description: "One line: what work belongs here (empty clears it)",
            },
            alias: {
              type: "string",
              repeatable: true,
              split: ",",
              description:
                "Other names for this workstream (replaces the list; repeat or comma-separate)",
            },
            json: { type: "boolean", description: "Print JSON" },
          },
          constraints: [
            { kind: "at-least-one", options: ["description", "alias"] },
          ],
          async run({ positionals, options }) {
            const section = resolveWorkstream(
              await listSections(bb.sdk),
              positionals.workstream,
            );
            if (!section)
              throw new PluginCliError(
                `No workstream named "${positionals.workstream}".`,
                {
                  code: "workstream_not_found",
                  hint: "Run `bb workstreams list` to see workstream names and ids.",
                },
              );
            map.edit(section.id, {
              description: options.description,
              aliases: options.alias.length ? options.alias : undefined,
            });
            journal.add({
              action: "edit-workstream",
              source: "user",
              rationale: `Edited ${section.name}`,
              threads: [],
              workstreams: [{ id: section.id, name: section.name }],
              undo: null,
            });
            const record = map.get(section.id);
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(record, null, 2)
                : `${section.name}: ${record?.description ?? "(no description)"}${record?.aliases.length ? `\nAlso called: ${record.aliases.join(", ")}` : ""}`,
            };
          },
        }),
        new: cliCommand({
          summary:
            "Start new work where it belongs: continue a thread, start one in a workstream, or start a new workstream",
          positionals: [
            {
              name: "prompt",
              description: "What the work is (the first message)",
              required: true,
            },
          ],
          options: {
            workstream: {
              type: "string",
              description: "Start it in this workstream (name or section id)",
            },
            project: {
              type: "string",
              description: "Prefer this project id",
            },
            "dry-run": {
              type: "boolean",
              description: "Print the route without acting",
            },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ positionals, options }) {
            const prompt = positionals.prompt;
            let workstreamId: string | null = null;
            if (options.workstream) {
              const section = resolveWorkstream(
                await listSections(bb.sdk),
                options.workstream,
              );
              if (!section)
                throw new PluginCliError(
                  `No workstream named "${options.workstream}".`,
                  { code: "workstream_not_found" },
                );
              workstreamId = section.id;
            }
            const decision = await router
              .route(prompt, {
                pickedProjectId: options.project ?? null,
                workstreamId,
              })
              .catch(fail);
            // Scripts can't see a preview: continue only when sure.
            const acted = await actOn(
              router,
              decision,
              positionals.prompt,
              options["dry-run"],
              "router",
            );
            return {
              exitCode: acted.outcome === "unsure" ? 3 : 0,
              stdout: options.json
                ? JSON.stringify(acted, null, 2)
                : describeOutcome(acted, options["dry-run"]),
            };
          },
        }),
        handoff: cliCommand({
          summary:
            "Hand an out-of-scope request to where it belongs: a new thread, a new workstream, or (when sure) an existing thread",
          options: {
            request: {
              type: "string",
              stdin: true,
              required: true,
              description:
                "The user's request, verbatim. Prefer --request-stdin with a quoted heredoc",
            },
            note: {
              type: "string",
              description: "Context for the receiving thread (one line)",
            },
            "dry-run": {
              type: "boolean",
              description: "Print the route without acting",
            },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ options }, ctx) {
            const caller = ctx.threadId;
            if (!caller)
              throw new PluginCliError(
                "Run handoff from inside a BB thread (BB_THREAD_ID is not set).",
                { code: "no_caller" },
              );
            const request = options.request.trim();
            if (!request)
              throw new PluginCliError("The request is empty.", {
                code: "empty_request",
              });
            if (!options["dry-run"])
              takeHandoffSlot(caller, await turnOf(bb, caller));
            const decision = await router
              .route(request, {
                // Never back to the caller, or to the thread that handed the
                // caller its work: a handoff doesn't bounce.
                exclude: [caller, ...(await handedOffFrom(bb, caller))],
                about: caller,
              })
              .catch(fail);
            const note = options.note
              ? ` (${options.note.replace(/\s+/g, " ").slice(0, 200)})`
              : "";
            // Plugin-sent messages show as the user's (SPEC §5), so the
            // receiving thread is told where this came from.
            const message = `Handed off from @thread:${caller}${note}. This is now this thread's task; the user continues here, so don't report back there.\n\n${request}`;
            const acted = await actOn(
              router,
              decision,
              request,
              options["dry-run"],
              "handoff",
              { message, spawnedFrom: caller },
            );
            return {
              exitCode: acted.outcome === "unsure" ? 3 : 0,
              stdout: options.json
                ? JSON.stringify(acted)
                : describeOutcome(acted, options["dry-run"]),
            };
          },
        }),
        rebuild: cliCommand({
          summary:
            "Organize every thread once: propose the workstream map, file threads, and preview the result",
          options: {
            apply: {
              type: "boolean",
              description:
                "Apply the previewed changes as one undoable batch (default: preview only)",
            },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ options }) {
            const fail = (state: BootstrapState | null) => {
              throw new PluginCliError(state?.error ?? "Organizing failed.", {
                code: "organize_failed",
              });
            };
            let state = await bootstrap.start().catch(fail);
            if (state.status !== "review") fail(state);
            state = await bootstrap
              .assign(state.changes.map((c) => ({ id: c.id, accepted: true })))
              .catch(fail);
            if (state.status !== "preview") fail(state);
            if (options.apply) {
              state = await bootstrap.apply().catch(fail);
              if (state.status !== "applied") fail(state);
            }
            if (options.json)
              return { exitCode: 0, stdout: JSON.stringify(state, null, 2) };
            const p = state.preview!;
            const moves = p.moves.filter((m) => m.accepted);
            const lines = [
              `${options.apply ? "Applied" : "Preview"}: ${plural(moves.length, "move")}, ${plural(p.creates.length, "new workstream")}, ${plural(p.renames.length, "rename")} (${(state.seconds.intake + state.seconds.map + state.seconds.assign + state.seconds.apply).toFixed(1)}s)`,
              ...state.changes.map(
                (c) =>
                  `  map: ${c.kind} ${"workstream" in c ? c.workstream : ""}${"name" in c ? ` → ${c.name}` : ""}${"into" in c ? ` → ${c.into}` : ""}`,
              ),
              ...p.moves.map(
                (m) =>
                  `  ${m.accepted ? "✓" : "·"} ${clip(m.title)}: ${m.fromName} → ${m.toName} (${m.reason})`,
              ),
              ...(p.unsure.length
                ? [`  unsure: ${p.unsure.map((u) => clip(u.title)).join("; ")}`]
                : []),
              ...(options.apply
                ? []
                : [
                    "",
                    "Review and apply on the Workstreams page, or rerun with --apply.",
                  ]),
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        cutover: cliCommand({
          summary:
            "After organizing, remove the data Workstreams v1 left behind (its key-value state and banner images)",
          options: {
            yes: {
              type: "boolean",
              description: "Remove it (default: show what would be removed)",
            },
          },
          async run({ options }) {
            if (!bootstrap.isDone())
              throw new PluginCliError(
                "Organize first (Workstreams → Map, or `bb workstreams rebuild`): it reads v1's change log to tell your filings from v1's.",
                { code: "not_organized" },
              );
            const db = bb.storage.database();
            const count = (table: string) => {
              try {
                return (
                  db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
                    n: number;
                  }
                ).n;
              } catch {
                return 0;
              }
            };
            const found = { state: count("state"), banners: count("banners") };
            if (!options.yes)
              return {
                exitCode: 0,
                stdout: `Would remove v1 data: ${found.state} state rows, ${found.banners} banner images. Rerun with --yes. Rolling back to v1 afterwards starts it with no history or analysis.`,
              };
            // Emptied, not dropped: v1's migration ledger still lists them.
            for (const table of ["banners", "state"])
              if (count(table) > 0) db.exec(`DELETE FROM ${table}`);
            return {
              exitCode: 0,
              stdout: `Removed v1 data (${found.state} state rows, ${found.banners} banner images). v1's settings (organize, diagnostics) have no effect in v2; clear them with \`bb plugin config workstreams unset <key>\` if you like.`,
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
      },
    }),
  );
}

export type Acted = {
  outcome: RouteDecision["outcome"];
  threadId: string | null;
  link: string | null;
  workstream: string | null;
  reason: string;
  candidates?: string[];
  /**
   * The routing call's debug trace (`bb workstreams trace <id>`); present
   * only when Debug mode recorded one.
   */
  traceId?: string;
};

/**
 * The policy for callers that can't preview (scripts, agent handoffs):
 * new threads and workstreams act at once, a continue acts only at high
 * confidence and otherwise starts a thread in that thread's workstream, and
 * unsure changes nothing.
 */
export async function actOn(
  router: Router,
  decision: RouteDecision,
  prompt: string,
  dryRun: boolean,
  source: "router" | "handoff",
  options: { message?: string; spawnedFrom?: string | null } = {},
): Promise<Acted> {
  let final = decision;
  // Continue only when sure; otherwise start a thread in the target's
  // workstream (SPEC §5), or change nothing when it has none.
  if (
    final.outcome === "continue" &&
    (final.confidence !== "high" || final.threadId === options.spawnedFrom)
  ) {
    router.forget(decision.id);
    final = final.sectionId
      ? {
          ...(await router.route(prompt, {
            workstreamId: final.sectionId,
            exclude: options.spawnedFrom ?? null,
          })),
          // The routing call that picked the thread still explains this.
          traceId: final.traceId,
        }
      : ({ ...final, outcome: "unsure", candidates: [] } as RouteDecision);
  }
  const workstream =
    final.outcome === "new-thread"
      ? final.workstream
      : final.outcome === "new-workstream"
        ? final.name
        : final.outcome === "continue"
          ? final.workstream
          : null;
  if (final.outcome === "unsure" || dryRun) {
    // A previewed route must not file a later thread with the same text.
    router.forget(decision.id);
    router.forget(final.id);
  }
  if (final.outcome === "unsure")
    return {
      outcome: "unsure",
      threadId: null,
      link: null,
      workstream: null,
      reason: final.reason,
      ...(final.traceId ? { traceId: final.traceId } : {}),
      candidates:
        "candidates" in final
          ? final.candidates.map((c) =>
              c.kind === "thread"
                ? `@thread:${c.threadId} (${c.title})`
                : `${c.name} (workstream)`,
            )
          : [],
    };
  const result = dryRun
    ? { threadId: final.outcome === "continue" ? final.threadId : null }
    : await router.execute(final, prompt, source, options);
  return {
    outcome: final.outcome,
    threadId: result.threadId,
    link: result.threadId ? `@thread:${result.threadId}` : null,
    workstream,
    reason: final.reason,
    ...(final.traceId ? { traceId: final.traceId } : {}),
  };
}

export function describeOutcome(acted: Acted, dryRun = false): string {
  if (acted.outcome === "unsure")
    return [
      `Not sure where this goes: ${acted.reason}`,
      ...(acted.candidates ?? []).map((c) => `  - ${c}`),
      "Nothing was started.",
    ].join("\n");
  const verb =
    acted.outcome === "continue"
      ? dryRun
        ? "Would send to"
        : "Sent to"
      : acted.outcome === "new-workstream"
        ? dryRun
          ? "Would start in new workstream"
          : "Started in new workstream"
        : dryRun
          ? "Would start in"
          : "Started in";
  return `${verb} ${acted.outcome === "continue" ? (acted.link ?? "") : (acted.workstream ?? "")}${
    acted.link && acted.outcome !== "continue" ? `: ${acted.link}` : ""
  }\n${acted.reason}`;
}

const HANDOFFS_PER_TURN = 3;
const handoffs = new Map<string, { turn: number; count: number }>();

/**
 * The caller's current turn: the last completed one, which changes when the
 * turn making these calls completes. If BB can't say, a 15-minute window
 * stands in so the limit can't stick forever.
 */
async function turnOf(bb: BbPluginApi, threadId: string): Promise<number> {
  try {
    const thread = await bb.sdk.threads.get({ threadId });
    return thread.latestAttentionAt ?? thread.updatedAt;
  } catch {
    return -Math.floor(Date.now() / (15 * 60_000));
  }
}

/** At most three handoffs per turn per calling thread (SPEC §5). */
function takeHandoffSlot(caller: string, turn: number): void {
  const current = handoffs.get(caller);
  const count = current && current.turn === turn ? current.count : 0;
  if (count >= HANDOFFS_PER_TURN)
    throw new PluginCliError(
      `This thread already handed off ${HANDOFFS_PER_TURN} requests this turn. Ask the user before handing off more.`,
      { code: "handoff_limit" },
    );
  handoffs.set(caller, { turn, count: count + 1 });
}

/** The thread a handoff came from, per the caller's Workstreams metadata. */
async function handedOffFrom(
  bb: BbPluginApi,
  threadId: string,
): Promise<string[]> {
  try {
    const metadata = (await bb.sdk.threads.getPluginMetadata({ threadId })) as {
      spawnedFrom?: unknown;
    };
    return typeof metadata.spawnedFrom === "string"
      ? [metadata.spawnedFrom]
      : [];
  } catch {
    return [];
  }
}
