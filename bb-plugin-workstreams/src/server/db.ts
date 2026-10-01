import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/**
 * Append-only migration list: statement index is the durable migration ID.
 * Applied entries must stay unchanged, even when later entries remove their
 * tables, so installed databases advance through the same history.
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
  `CREATE TABLE ws_understanding_progress (
    thread_id TEXT PRIMARY KEY,
    cursor TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    error TEXT,
    updated_at INTEGER NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE ws_understanding_observation (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    speaker TEXT NOT NULL,
    quote TEXT NOT NULL,
    observation TEXT NOT NULL,
    epistemic TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(thread_id, entry_id, observation)
  )`,
  "CREATE INDEX ws_understanding_observation_thread ON ws_understanding_observation(thread_id)",
  `CREATE TABLE ws_understanding_account (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    narrative TEXT NOT NULL,
    questions TEXT NOT NULL,
    evidence_ids TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE ws_understanding_account_observation (
    account_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    PRIMARY KEY(account_id, observation_id)
  )`,
  "ALTER TABLE ws_understanding_observation ADD COLUMN source_at INTEGER",
  "ALTER TABLE ws_understanding_observation ADD COLUMN terms TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE ws_understanding_progress ADD COLUMN completed_revision INTEGER",
  "ALTER TABLE ws_understanding_progress ADD COLUMN backlog INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE ws_understanding_observation ADD COLUMN trace_id TEXT",
  "ALTER TABLE ws_understanding_account ADD COLUMN trace_id TEXT",
  `CREATE TABLE ws_understanding_revision (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    action TEXT NOT NULL,
    before TEXT,
    after TEXT,
    trace_id TEXT,
    reason TEXT NOT NULL
  )`,
  "CREATE INDEX ws_understanding_revision_account ON ws_understanding_revision(account_id, at DESC, id DESC)",
  `CREATE TABLE ws_understanding_retrieval (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    consumer TEXT NOT NULL,
    thread_id TEXT,
    trace_id TEXT,
    report TEXT NOT NULL
  )`,
  "CREATE INDEX ws_understanding_retrieval_thread ON ws_understanding_retrieval(thread_id, at DESC, id DESC)",
  "CREATE INDEX ws_understanding_retrieval_trace ON ws_understanding_retrieval(trace_id, at DESC, id DESC)",
  `CREATE TABLE ws_notebook (
    thread_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    cursor TEXT,
    revision INTEGER,
    error TEXT
  )`,
  `CREATE TABLE ws_notebook_brief (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE ws_notebook_run (
    id TEXT PRIMARY KEY,
    thread_id TEXT,
    question TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    summary TEXT NOT NULL,
    error TEXT,
    steps TEXT NOT NULL,
    usage TEXT NOT NULL,
    model TEXT NOT NULL
  )`,
  "CREATE INDEX ws_notebook_run_started ON ws_notebook_run(started_at DESC)",
  `CREATE TABLE ws_notebook_version (
    id TEXT PRIMARY KEY,
    thread_id TEXT,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    run_id TEXT
  )`,
  "CREATE INDEX ws_notebook_version_doc ON ws_notebook_version(thread_id, at DESC)",
  `CREATE TABLE ws_notebook_dependency (
    doc_thread_id TEXT,
    source_thread_id TEXT NOT NULL,
    PRIMARY KEY(doc_thread_id, source_thread_id)
  )`,
  "CREATE INDEX ws_notebook_dependency_source ON ws_notebook_dependency(source_thread_id)",
  `CREATE TABLE ws_notebook_run_dependency (
    run_id TEXT NOT NULL,
    source_thread_id TEXT NOT NULL,
    PRIMARY KEY(run_id, source_thread_id)
  )`,
  "CREATE INDEX ws_notebook_run_dependency_source ON ws_notebook_run_dependency(source_thread_id)",
  "DROP TABLE IF EXISTS ws_understanding_retrieval",
  "DROP TABLE IF EXISTS ws_understanding_revision",
  "DROP TABLE IF EXISTS ws_understanding_account_observation",
  "DROP TABLE IF EXISTS ws_understanding_account",
  "DROP TABLE IF EXISTS ws_understanding_observation",
  "DROP TABLE IF EXISTS ws_understanding_progress",
  "DELETE FROM ws_trace_link WHERE trace_id IN (SELECT id FROM ws_trace WHERE kind IN ('understanding-extract','understanding-synthesis'))",
  "DELETE FROM ws_trace WHERE kind IN ('understanding-extract','understanding-synthesis')",
  "ALTER TABLE ws_notebook ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 0",
  `INSERT OR IGNORE INTO ws_placement(thread_id,section_id,source,entry_id,at)
    SELECT t.thread_id,t.section_id,'auto',NULL,0 FROM ws_seen_thread t
    JOIN ws_seen_section s ON s.section_id=t.section_id
    JOIN json_each(CASE WHEN json_valid((SELECT value FROM state WHERE key='organize-log')) THEN (SELECT value FROM state WHERE key='organize-log') ELSE '[]' END) e
      ON json_extract(e.value,'$.action.threadId')=t.thread_id
    WHERE json_extract(e.value,'$.action.kind')='section' AND json_extract(e.value,'$.result')='done'
      AND COALESCE(json_extract(e.value,'$.undone'),0)=0
      AND (json_extract(e.value,'$.undo.workstreamsSectionId')=t.section_id
        OR lower(json_extract(e.value,'$.action.section'))=lower(s.name))`,
  "DROP TABLE IF EXISTS banners",
  "DROP TABLE IF EXISTS state",
  "ALTER TABLE ws_proposal ADD COLUMN snapshot TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE ws_proposal ADD COLUMN reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ws_proposal ADD COLUMN confidence REAL NOT NULL DEFAULT 0",
  "ALTER TABLE ws_recap ADD COLUMN revision INTEGER",
  "ALTER TABLE ws_workstream ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 0",
  "DROP TABLE IF EXISTS ws_notebook_run_dependency",
  "DROP TABLE IF EXISTS ws_notebook_dependency",
  "DROP TABLE IF EXISTS ws_notebook_version",
  "DROP TABLE IF EXISTS ws_notebook_run",
  "DROP TABLE IF EXISTS ws_notebook_brief",
  "DROP TABLE IF EXISTS ws_notebook",
  "DROP TABLE IF EXISTS ws_proposal",
  "DROP TABLE IF EXISTS ws_snooze",
  "DELETE FROM ws_meta WHERE key IN ('bootstrap', 'supervision_snapshot', 'supervision_failure')",
  "DELETE FROM ws_trace_link WHERE trace_id IN (SELECT id FROM ws_trace WHERE kind IN ('organize-map','organize-assign','file-unsorted','describe','supervision'))",
  "DELETE FROM ws_trace WHERE kind IN ('organize-map','organize-assign','file-unsorted','describe','supervision')",
  "UPDATE ws_journal SET status = 'dismissed' WHERE action = 'proposal' AND status = 'pending'",
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
