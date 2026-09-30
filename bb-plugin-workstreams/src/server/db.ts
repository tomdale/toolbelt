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
  "ALTER TABLE ws_workstream ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE ws_workstream ADD COLUMN subjects TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE ws_workstream ADD COLUMN projects TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE ws_workstream ADD COLUMN evidence TEXT NOT NULL DEFAULT '{}'",
  `CREATE TABLE ws_proposal (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    subject TEXT NOT NULL,
    source_section_id TEXT NOT NULL,
    target_section_id TEXT,
    new_name TEXT,
    thread_ids TEXT NOT NULL,
    evidence_count INTEGER NOT NULL,
    entry_id TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX ws_proposal_status ON ws_proposal (status, updated_at DESC)",
  "CREATE TABLE ws_snooze (key TEXT PRIMARY KEY, evidence_count INTEGER NOT NULL, at INTEGER NOT NULL)",
  "ALTER TABLE ws_seen_thread ADD COLUMN title TEXT",
  `CREATE TABLE ws_project_shape (
    project_id TEXT PRIMARY KEY,
    shape TEXT NOT NULL,
    checked_at INTEGER NOT NULL
  )`,
  "CREATE TABLE ws_drift_dismissed (thread_id TEXT PRIMARY KEY, target TEXT NOT NULL, at INTEGER NOT NULL)",
  `CREATE TABLE ws_title (
    thread_id TEXT PRIMARY KEY,
    observed TEXT,
    written TEXT,
    locked INTEGER NOT NULL DEFAULT 0,
    retitled_at INTEGER
  )`,
  `CREATE TABLE ws_trace (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    label TEXT NOT NULL,
    model TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    replay_of TEXT,
    data TEXT NOT NULL
  )`,
  "CREATE INDEX ws_trace_at ON ws_trace (at DESC)",
  `CREATE TABLE ws_trace_link (
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    PRIMARY KEY (kind, ref, trace_id)
  )`,
  "CREATE INDEX ws_trace_link_trace ON ws_trace_link (trace_id)",
  "CREATE TABLE ws_archive_dismissed (thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)",
  `CREATE TABLE ws_recap (
    thread_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    turns INTEGER NOT NULL,
    model TEXT NOT NULL
  )`,
  "ALTER TABLE ws_workstream ADD COLUMN concepts TEXT NOT NULL DEFAULT '[]'",
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
