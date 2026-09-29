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

export function registerCli(
  bb: BbPluginApi,
  service: WorkstreamService,
  journal: Journal,
  analyzer: Analyzer,
  bootstrap: Bootstrap,
  map: WorkstreamMap,
  router: Router,
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
            let prompt = positionals.prompt;
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
              prompt = `@section:${section.id} ${prompt}`;
            }
            const decision = await router
              .route(prompt, { pickedProjectId: options.project ?? null })
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
              .route(request, { exclude: caller })
              .catch(fail);
            const note = options.note
              ? ` (${options.note.replace(/\s+/g, " ").slice(0, 200)})`
              : "";
            // Plugin-sent messages show as the user's (SPEC §5), so the
            // receiving thread is told where this came from.
            const message = `Handed off from @thread:${caller}${note}:\n\n${request}`;
            const acted = await actOn(
              router,
              decision,
              request,
              options["dry-run"],
              "handoff",
              { message, spawnedFrom: caller },
            );
            if (acted.threadId === caller)
              throw new PluginCliError(
                "A handoff can't go back to its own thread.",
                {
                  code: "handoff_to_self",
                },
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
  if (decision.outcome === "continue" && decision.confidence !== "high")
    final = await router.route(prompt, {
      exclude: [
        decision.threadId,
        ...(options.spawnedFrom ? [options.spawnedFrom] : []),
      ],
    });
  if (final.outcome === "continue" && final.confidence !== "high")
    final = { ...final, outcome: "unsure", candidates: [] } as RouteDecision;
  const workstream =
    final.outcome === "new-thread"
      ? final.workstream
      : final.outcome === "new-workstream"
        ? final.name
        : final.outcome === "continue"
          ? final.workstream
          : null;
  if (final.outcome === "unsure")
    return {
      outcome: "unsure",
      threadId: null,
      link: null,
      workstream: null,
      reason: final.reason,
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

/** The caller's current turn, as far as BB records it. */
async function turnOf(bb: BbPluginApi, threadId: string): Promise<number> {
  try {
    const thread = await bb.sdk.threads.get({ threadId });
    return thread.latestAttentionAt ?? thread.updatedAt;
  } catch {
    return 0;
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
