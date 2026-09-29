/**
 * The journal records every change Workstreams makes or observes (SPEC I7,
 * §11.5). It backs undo and the Activity log, so each change appears once.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.ts";

export const sourceSchema = z.enum([
  "user",
  "external",
  "router",
  "handoff",
  "auto",
  "proposal",
  "bootstrap",
]);
export type Source = z.infer<typeof sourceSchema>;

export const actionSchema = z.enum([
  "move",
  "create-workstream",
  "rename-workstream",
  "delete-workstream",
  "undo",
  /** Several changes applied and undone together (bootstrap, proposals). */
  "batch",
  /** A workstream proposal waiting for a decision (SPEC §9). */
  "proposal",
  "edit-workstream",
]);
export type Action = z.infer<typeof actionSchema>;

export const statusSchema = z.enum([
  "applied",
  "partial",
  "undone",
  "failed",
  "pending",
  "dismissed",
]);

const stepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("move"),
    moves: z.array(
      z.object({
        threadId: z.string(),
        from: z.string().nullable(),
        to: z.string().nullable(),
      }),
    ),
  }),
  z.object({
    kind: z.literal("delete-section"),
    sectionId: z.string(),
    /**
     * Set inside a batch: an undo that finds the section still in use skips
     * it instead of failing the whole batch.
     */
    inBatch: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("rename-section"),
    sectionId: z.string(),
    from: z.string(),
    to: z.string(),
  }),
]);
export type UndoStep = z.infer<typeof stepSchema>;

const undoSchema = z.union([
  stepSchema,
  /** Undone in reverse order as one change. */
  z.object({ kind: z.literal("batch"), steps: z.array(stepSchema) }),
]);
export type UndoPlan = z.infer<typeof undoSchema>;

const refSchema = z.object({ id: z.string(), name: z.string() });

export const entrySchema = z.object({
  id: z.string(),
  at: z.number(),
  action: actionSchema,
  source: sourceSchema,
  status: statusSchema,
  rationale: z.string(),
  threads: z.array(refSchema),
  workstreams: z.array(refSchema),
  undo: undoSchema.nullable(),
  undoes: z.string().nullable(),
  undoneBy: z.string().nullable(),
  detail: z.string().nullable(),
});
export type JournalEntry = z.infer<typeof entrySchema>;

export type NewEntry = Omit<
  JournalEntry,
  "id" | "at" | "undoes" | "undoneBy" | "detail" | "status"
> &
  Partial<Pick<JournalEntry, "undoes" | "detail" | "status">>;

const RATIONALE_MAX = 120;
const RETAIN_MS = 90 * 24 * 60 * 60 * 1000;
const RETAIN_ENTRIES = 2000;

type Row = {
  id: string;
  at: number;
  action: string;
  source: string;
  status: string;
  rationale: string;
  subject: string;
  undo: string | null;
  undoes: string | null;
  undone_by: string | null;
  detail: string | null;
};

function fromRow(row: Row): JournalEntry {
  const subject = JSON.parse(row.subject) as {
    threads: { id: string; name: string }[];
    workstreams: { id: string; name: string }[];
  };
  return entrySchema.parse({
    id: row.id,
    at: row.at,
    action: row.action,
    source: row.source,
    status: row.status,
    rationale: row.rationale,
    threads: subject.threads,
    workstreams: subject.workstreams,
    undo: row.undo ? JSON.parse(row.undo) : null,
    undoes: row.undoes,
    undoneBy: row.undone_by,
    detail: row.detail,
  });
}

export class Journal {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  add(entry: NewEntry): JournalEntry {
    const full: JournalEntry = {
      status: "applied",
      undoes: null,
      detail: null,
      ...entry,
      id: randomUUID(),
      at: this.now(),
      rationale: clip(entry.rationale),
      undoneBy: null,
    };
    this.db
      .prepare(
        `INSERT INTO ws_journal (id, at, action, source, status, rationale, subject, undo, undoes, undone_by, detail)
         VALUES (@id, @at, @action, @source, @status, @rationale, @subject, @undo, @undoes, NULL, @detail)`,
      )
      .run({
        id: full.id,
        at: full.at,
        action: full.action,
        source: full.source,
        status: full.status,
        rationale: full.rationale,
        subject: JSON.stringify({
          threads: full.threads,
          workstreams: full.workstreams,
        }),
        undo: full.undo ? JSON.stringify(full.undo) : null,
        undoes: full.undoes,
        detail: full.detail,
      });
    this.prune();
    return full;
  }

  get(id: string): JournalEntry | null {
    const row = this.db
      .prepare("SELECT * FROM ws_journal WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(
    options: { limit?: number; before?: number; external?: boolean } = {},
  ): JournalEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT * FROM ws_journal
         WHERE at < @before AND (@external = 1 OR source <> 'external')
         ORDER BY at DESC, rowid DESC LIMIT @limit`,
      )
      .all({
        before: options.before ?? Number.MAX_SAFE_INTEGER,
        external: options.external ? 1 : 0,
        limit,
      }) as Row[];
    return rows.map(fromRow);
  }

  /** Updates a pending proposal once it is applied, dismissed, or expired. */
  update(
    id: string,
    patch: Partial<
      Pick<
        JournalEntry,
        "status" | "rationale" | "detail" | "undo" | "threads" | "workstreams"
      >
    >,
  ): void {
    const current = this.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE ws_journal SET status = @status, rationale = @rationale, detail = @detail,
           undo = @undo, subject = @subject WHERE id = @id`,
      )
      .run({
        id,
        status: next.status,
        rationale: clip(next.rationale),
        detail: next.detail,
        undo: next.undo ? JSON.stringify(next.undo) : null,
        subject: JSON.stringify({
          threads: next.threads,
          workstreams: next.workstreams,
        }),
      });
  }

  markUndone(id: string, undoneBy: string): void {
    this.db
      .prepare(
        "UPDATE ws_journal SET status = 'undone', undone_by = ? WHERE id = ?",
      )
      .run(undoneBy, id);
  }

  private prune(): void {
    this.db
      .prepare(
        `DELETE FROM ws_journal WHERE at < @cutoff OR id NOT IN (
           SELECT id FROM ws_journal ORDER BY at DESC, rowid DESC LIMIT @keep)`,
      )
      .run({ cutoff: this.now() - RETAIN_MS, keep: RETAIN_ENTRIES });
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= RATIONALE_MAX
    ? flat
    : `${flat.slice(0, RATIONALE_MAX - 1)}…`;
}
