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

export function registerCli(
  bb: BbPluginApi,
  service: WorkstreamService,
  journal: Journal,
): void {
  const load = async () => {
    const [threads, sections] = await Promise.all([
      listActiveThreads(bb.sdk),
      listSections(bb.sdk),
    ]);
    const now = Date.now();
    return {
      now,
      sections,
      projection: projectWorkstreams(threads, sections, { now }),
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
            const { now, sections, projection } = await load();
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
                    })),
                  },
                  null,
                  2,
                ),
              };
            const lines = rows.map(
              (r) =>
                `${"  ".repeat(Math.min(r.depth, 4))}${r.needsYou ? "? " : ""}${clip(r.thread.title)}  · ${relativeAge(r.thread.latestAttentionAt, now)}  (${r.thread.id})`,
            );
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
