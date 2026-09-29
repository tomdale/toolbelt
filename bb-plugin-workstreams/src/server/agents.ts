/**
 * Per-thread agent instructions (SPEC §5) and the project-shape cache they
 * depend on.
 *
 * `configure` is synchronous and its context has no section or visibility,
 * so role and workstream come from the thread's metadata plus the
 * reconciler's SQLite snapshot of visible threads. A thread in neither (a
 * hidden helper, or one created seconds ago) gets nothing until its session
 * next starts. Side chats never get instructions.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  instructionsFor,
  type ProjectShape,
  type ThreadRole,
} from "../domain/instructions.ts";
import type { Database } from "./db.ts";

type Sdk = BbPluginApi["sdk"];
type Seen = {
  section_id: string | null;
  parent_thread_id: string | null;
  title: string | null;
};

const SHAPE_TTL_MS = 24 * 60 * 60_000;

export function roleOf(
  db: Database,
  context: {
    thread: { id: string; parentThreadId: string | null };
    project: { id: string; kind: "personal" | "standard" };
    origin: { kind: "fork" | null; pluginId: string | null };
    pluginMetadata: Readonly<Record<string, unknown>>;
  },
  now?: number,
): ThreadRole | null {
  if (context.origin.kind === "fork" && context.origin.pluginId === "side-chat")
    return null;
  const lookup = db.prepare(
    "SELECT section_id, parent_thread_id, title FROM ws_seen_thread WHERE thread_id = ?",
  );
  const seen = lookup.get(context.thread.id) as Seen | undefined;
  const kind = context.pluginMetadata.kind;
  // An unseen thread is trusted only on metadata Workstreams wrote moments
  // ago (a thread it just spawned). Older metadata could be a copy on a
  // hidden fork, and configure can't see visibility.
  const filedAt = context.pluginMetadata.filedAt;
  const fresh =
    typeof filedAt === "number" && (now ?? Date.now()) - filedAt < 10 * 60_000;
  if (!seen && !((kind === "task" || kind === "delegate") && fresh))
    return null;

  const parentId = context.thread.parentThreadId;
  const parent = parentId
    ? (lookup.get(parentId) as Seen | undefined)
    : undefined;
  if (parentId && (parent || kind === "delegate"))
    return { kind: "delegate", parentTitle: parent?.title ?? null };

  // A root's workstream is its own section (SPEC I2).
  const sectionId =
    seen?.section_id ??
    (typeof context.pluginMetadata.filedSectionId === "string"
      ? context.pluginMetadata.filedSectionId
      : null);
  const workstream = sectionId
    ? (db
        .prepare(
          `SELECT s.name, w.description FROM ws_seen_section s
           LEFT JOIN ws_workstream w ON w.section_id = s.section_id WHERE s.section_id = ?`,
        )
        .get(sectionId) as
        { name: string; description: string | null } | undefined)
    : undefined;
  const shape: ProjectShape =
    context.project.kind === "personal"
      ? "none"
      : (((
          db
            .prepare("SELECT shape FROM ws_project_shape WHERE project_id = ?")
            .get(context.project.id) as { shape: ProjectShape } | undefined
        )?.shape ?? "unknown") as ProjectShape);
  return {
    kind: "task",
    workstream: workstream
      ? { name: workstream.name, description: workstream.description }
      : null,
    shape,
  };
}

export function registerAgentInstructions(bb: BbPluginApi, db: Database): void {
  bb.agents.configure((context) => {
    const role = roleOf(db, {
      thread: context.thread,
      project: context.project,
      origin: context.origin,
      pluginMetadata: context.pluginMetadata as Record<string, unknown>,
    });
    return role
      ? { tools: [], skills: [], instructions: instructionsFor(role) }
      : { tools: [], skills: [] };
  });
}

/**
 * Classifies project roots (SPEC §3): a git checkout, a Workforest workspace
 * (a directory of repositories with no root repository), or neither. Cached
 * per project and rechecked daily.
 */
export async function refreshShapes(
  sdk: Sdk,
  db: Database,
  probe: (
    hostId: string,
    path: string,
  ) => Promise<{
    exists: boolean;
    rootRepo: boolean;
    childRepos: number;
  }>,
  now = Date.now(),
): Promise<void> {
  const checked = new Map(
    (
      db
        .prepare("SELECT project_id, checked_at FROM ws_project_shape")
        .all() as {
        project_id: string;
        checked_at: number;
      }[]
    ).map((r) => [r.project_id, r.checked_at]),
  );
  const projects = (await sdk.projects.list()) as {
    id: string;
    kind?: string;
    sources?: { hostId: string; path?: string; isDefault?: boolean }[];
  }[];
  const save = db.prepare(
    `INSERT INTO ws_project_shape (project_id, shape, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET shape = excluded.shape, checked_at = excluded.checked_at`,
  );
  for (const project of projects) {
    if (now - (checked.get(project.id) ?? 0) < SHAPE_TTL_MS) continue;
    const source =
      project.sources?.find((s) => s.isDefault) ?? project.sources?.[0];
    if (!source?.path) continue;
    try {
      const found = await probe(source.hostId, source.path);
      const shape: ProjectShape = !found.exists
        ? "unknown"
        : found.rootRepo
          ? "git"
          : found.childRepos > 0
            ? "workforest"
            : // A plain directory: neither shape's guidance applies.
              "unknown";
      save.run(project.id, shape, now);
    } catch {
      // The machine may be offline; try again on the next pass.
    }
  }
}
