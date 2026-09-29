import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/**
 * Append-only migration list (statement index = migration id). The first two
 * statements are Workstreams v1's tables. They stay in the list, unchanged,
 * because v1 already applied them to this plugin's database; v2 never reads
 * them.
 */
const MIGRATIONS = [
  "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS banners (key TEXT PRIMARY KEY, name TEXT NOT NULL, motif TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, cost REAL NOT NULL, at INTEGER NOT NULL)",
  `CREATE TABLE ws_workstream (
    section_id TEXT PRIMARY KEY,
    description TEXT,
    description_source TEXT NOT NULL DEFAULT 'generated',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE ws_placement (
    thread_id TEXT PRIMARY KEY,
    section_id TEXT,
    source TEXT NOT NULL,
    entry_id TEXT,
    at INTEGER NOT NULL
  )`,
  `CREATE TABLE ws_journal (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    action TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    rationale TEXT NOT NULL,
    subject TEXT NOT NULL,
    undo TEXT,
    undoes TEXT,
    undone_by TEXT,
    detail TEXT
  )`,
  "CREATE INDEX ws_journal_at ON ws_journal (at DESC)",
  `CREATE TABLE ws_seen_thread (
    thread_id TEXT PRIMARY KEY,
    section_id TEXT,
    parent_thread_id TEXT
  )`,
  "CREATE TABLE ws_seen_section (section_id TEXT PRIMARY KEY, name TEXT NOT NULL)",
  "CREATE TABLE ws_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE ws_analysis (
    thread_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    at INTEGER NOT NULL,
    result TEXT NOT NULL
  )`,
];

export function openDatabase(bb: BbPluginApi): Database {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  return db;
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM ws_meta WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO ws_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
