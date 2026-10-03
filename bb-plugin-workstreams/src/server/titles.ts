/**
 * Storage for thread title ownership (`ws_title`). The rules live in
 * `domain/titles.ts`; this module only reads and writes records.
 */
import type { Database } from "./db.ts";
import { observeTitle, type TitleRecord } from "../domain/titles.ts";

type Row = {
  observed: string | null;
  written: string | null;
  locked: number;
  retitled_at: number | null;
  provisional: number;
};

export function readTitleRecord(
  db: Database,
  threadId: string,
): TitleRecord | undefined {
  const row = db
    .prepare(
      "SELECT observed, written, locked, retitled_at, provisional FROM ws_title WHERE thread_id = ?",
    )
    .get(threadId) as Row | undefined;
  return row
    ? {
        observed: row.observed,
        written: row.written,
        locked: row.locked === 1,
        retitledAt: row.retitled_at,
        provisional: row.provisional === 1,
      }
    : undefined;
}

export function writeTitleRecord(
  db: Database,
  threadId: string,
  record: TitleRecord,
): void {
  db.prepare(
    `INSERT INTO ws_title (thread_id, observed, written, locked, retitled_at, provisional) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET observed = excluded.observed, written = excluded.written,
       locked = excluded.locked, retitled_at = excluded.retitled_at, provisional = excluded.provisional`,
  ).run(
    threadId,
    record.observed,
    record.written,
    record.locked ? 1 : 0,
    record.retitledAt,
    record.provisional ? 1 : 0,
  );
}

/** Records the thread's current raw title and returns the updated record. */
export function observeThreadTitle(
  db: Database,
  threadId: string,
  raw: string | null,
): TitleRecord {
  const before = readTitleRecord(db, threadId);
  const after = observeTitle(before, raw);
  if (after !== before) writeTitleRecord(db, threadId, after);
  return after;
}

export function forgetTitle(db: Database, threadId: string): void {
  db.prepare("DELETE FROM ws_title WHERE thread_id = ?").run(threadId);
}
