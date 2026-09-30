/**
 * Debug traces (SPEC §11.6). With the `debug` setting on, each model call
 * records its prompt, the model's reasoning and raw response, the parsed
 * result, and what Workstreams did with it. Links tie a trace to what it
 * explains (a thread, a journal entry, a proposal, a workstream description,
 * an organizing run), so every surface can open the calls behind it.
 *
 * Traces hold redacted thread excerpts. They stay in the plugin database for
 * 7 days, at most 1,000 of them, and nothing is recorded while debug mode is
 * off.
 */
import { randomUUID } from "node:crypto";
import { redact } from "../domain/analysis.ts";
import {
  traceSchema,
  usageSchema,
  type NewTrace,
  type Trace,
  type TraceKind,
  type TraceLink,
  type TraceStatus,
  type TraceSummary,
  type Usage,
} from "../domain/trace.ts";
import type { Database } from "./db.ts";

const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const RETAIN_TRACES = 1000;
const PRUNE_EVERY_MS = 60_000;
const LABEL_MAX = 120;
const ERROR_MAX = 2000;
const INPUT_STRING_MAX = 4000;

/** JSON-safe copy with secrets redacted and long strings bounded. */
export function boundedJson(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    const clean = redact(value);
    return clean.length <= INPUT_STRING_MAX
      ? clean
      : `${clean.slice(0, INPUT_STRING_MAX)}… [${clean.length - INPUT_STRING_MAX} more characters]`;
  }
  if (value === null || typeof value !== "object") return value ?? null;
  if (depth > 8) return "[…]";
  if (Array.isArray(value))
    return value.map((item) => boundedJson(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, boundedJson(item, depth + 1)]),
  );
}

export const clipText = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

type Row = {
  id: string;
  at: number;
  kind: TraceKind;
  status: TraceStatus;
  label: string;
  model: string;
  duration_ms: number;
  replay_of: string | null;
  usage: string | null;
  error: string | null;
};

const SUMMARY_COLUMNS = `t.id, t.at, t.kind, t.status, t.label, t.model, t.duration_ms, t.replay_of,
  json_extract(t.data, '$.usage') AS usage, json_extract(t.data, '$.error') AS error`;

function summaryOf(row: Row): TraceSummary {
  let usage: Usage | null = null;
  try {
    usage = row.usage ? usageSchema.parse(JSON.parse(row.usage)) : null;
  } catch {
    usage = null;
  }
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    status: row.status,
    label: row.label,
    model: row.model,
    durationMs: row.duration_ms,
    replayOf: row.replay_of,
    usage,
    error: row.error,
  };
}

export class TraceStore {
  private prunedAt = 0;

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  add(trace: NewTrace, links: readonly TraceLink[] = []): string {
    const id = randomUUID();
    const { at, kind, status, label, model, durationMs, replayOf, ...data } =
      trace;
    this.db
      .prepare(
        `INSERT INTO ws_trace (id, at, kind, status, label, model, duration_ms, replay_of, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        at,
        kind,
        status,
        clipText(redact(label), LABEL_MAX),
        model,
        Math.round(durationMs),
        replayOf,
        JSON.stringify({
          ...data,
          error: data.error ? clipText(data.error, ERROR_MAX) : null,
        }),
      );
    this.link(id, links);
    this.prune();
    return id;
  }

  get(id: string): Trace | null {
    const row = this.db
      .prepare("SELECT * FROM ws_trace WHERE id = ?")
      .get(id) as (Omit<Row, "usage" | "error"> & { data: string }) | undefined;
    if (!row) return null;
    const data = JSON.parse(row.data) as Record<string, unknown>;
    const links = this.db
      .prepare(
        "SELECT kind, ref FROM ws_trace_link WHERE trace_id = ? ORDER BY kind, ref",
      )
      .all(id) as TraceLink[];
    const replays = (
      this.db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM ws_trace t WHERE t.replay_of = ? ORDER BY t.at ASC`,
        )
        .all(id) as Row[]
    ).map(summaryOf);
    return traceSchema.parse({
      provider: "",
      thinking: "",
      system: "",
      prompt: "",
      input: null,
      response: null,
      reasoning: null,
      stopReason: null,
      parsed: null,
      outcome: null,
      usage: null,
      error: null,
      ...data,
      id: row.id,
      at: row.at,
      kind: row.kind,
      status: row.status,
      label: row.label,
      model: row.model,
      durationMs: row.duration_ms,
      replayOf: row.replay_of,
      links,
      replays,
    });
  }

  /**
   * Newest first, replays excluded. `ids` keeps the given traces; `link`
   * keeps traces linked to that thread, entry, proposal, workstream, or run.
   */
  list(
    options: {
      ids?: readonly string[];
      link?: TraceLink;
      kind?: TraceKind;
      limit?: number;
      /** Page cursor: the last trace of the previous page. */
      before?: { at: number; id: string };
    } = {},
  ): TraceSummary[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const where = ["t.replay_of IS NULL"];
    const params: Record<string, unknown> = { limit };
    if (options.before) {
      // Calls in one organizing run can share a millisecond; rowid breaks ties.
      where.push(
        `(t.at < @beforeAt OR (t.at = @beforeAt AND t.rowid < COALESCE(
           (SELECT rowid FROM ws_trace WHERE id = @beforeId), 0)))`,
      );
      params.beforeAt = options.before.at;
      params.beforeId = options.before.id;
    }
    let join = "";
    if (options.link) {
      join = "JOIN ws_trace_link l ON l.trace_id = t.id";
      where.push("l.kind = @linkKind AND l.ref = @linkRef");
      params.linkKind = options.link.kind;
      params.linkRef = options.link.ref;
    }
    if (options.kind) {
      where.push("t.kind = @kind");
      params.kind = options.kind;
    }
    if (options.ids) {
      if (options.ids.length === 0) return [];
      where.push("t.id IN (SELECT value FROM json_each(@ids))");
      params.ids = JSON.stringify(options.ids);
    }
    return (
      this.db
        .prepare(
          `SELECT DISTINCT ${SUMMARY_COLUMNS} FROM ws_trace t ${join}
           WHERE ${where.join(" AND ")} ORDER BY t.at DESC, t.rowid DESC LIMIT @limit`,
        )
        .all(params) as Row[]
    ).map(summaryOf);
  }

  /** Trace ids linked to each ref of one kind, newest first. */
  idsFor(
    kind: TraceLink["kind"],
    refs: readonly string[],
  ): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (refs.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT l.ref, l.trace_id FROM ws_trace_link l JOIN ws_trace t ON t.id = l.trace_id
         WHERE l.kind = ? AND l.ref IN (SELECT value FROM json_each(?))
         ORDER BY t.at DESC, t.rowid DESC`,
      )
      .all(kind, JSON.stringify(refs)) as { ref: string; trace_id: string }[];
    for (const row of rows)
      out.set(row.ref, [...(out.get(row.ref) ?? []), row.trace_id]);
    return out;
  }

  link(traceId: string, links: readonly TraceLink[]): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO ws_trace_link (kind, ref, trace_id) SELECT ?, ?, id FROM ws_trace WHERE id = ?",
    );
    for (const link of links) insert.run(link.kind, link.ref, traceId);
  }

  /** Links everything linked to `from` to `to` as well. */
  copyLinks(from: TraceLink, to: TraceLink): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ws_trace_link (kind, ref, trace_id)
         SELECT ?, ?, trace_id FROM ws_trace_link WHERE kind = ? AND ref = ?`,
      )
      .run(to.kind, to.ref, from.kind, from.ref);
  }

  /**
   * Records what Workstreams did with a call's result. Each note merges into
   * the outcome, so later steps (a retitle after an analysis) add to it.
   */
  annotate(traceId: string, outcome: Record<string, unknown>): void {
    const row = this.db
      .prepare(
        "SELECT json_extract(data, '$.outcome') AS outcome FROM ws_trace WHERE id = ?",
      )
      .get(traceId) as { outcome: string | null } | undefined;
    if (!row) return;
    let current: unknown = null;
    try {
      current = row.outcome ? JSON.parse(row.outcome) : null;
    } catch {
      current = null;
    }
    const merged = {
      ...(current && typeof current === "object" && !Array.isArray(current)
        ? current
        : {}),
      ...outcome,
    };
    this.db
      .prepare(
        "UPDATE ws_trace SET data = json_set(data, '$.outcome', json(?)) WHERE id = ?",
      )
      .run(JSON.stringify(boundedJson(merged)), traceId);
  }

  clear(): number {
    const removed = this.db.prepare("DELETE FROM ws_trace").run().changes;
    this.db.prepare("DELETE FROM ws_trace_link").run();
    return Number(removed);
  }

  /**
   * Applies retention (7 days, 1,000 traces). Runs after recording and on the
   * reconciler's interval, so records age out after Debug mode is turned off.
   */
  prune({ force = false } = {}): void {
    if (!force && this.now() - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = this.now();
    this.db
      .prepare(
        `DELETE FROM ws_trace WHERE at < @cutoff OR id NOT IN (
           SELECT id FROM ws_trace ORDER BY at DESC, rowid DESC LIMIT @keep)`,
      )
      .run({ cutoff: this.now() - RETAIN_MS, keep: RETAIN_TRACES });
    this.db
      .prepare(
        `DELETE FROM ws_trace WHERE replay_of IS NOT NULL
           AND replay_of NOT IN (SELECT id FROM ws_trace)`,
      )
      .run();
    this.db
      .prepare(
        "DELETE FROM ws_trace_link WHERE trace_id NOT IN (SELECT id FROM ws_trace)",
      )
      .run();
  }
}
