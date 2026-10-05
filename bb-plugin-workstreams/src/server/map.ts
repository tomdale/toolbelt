/**
 * The workstream view (SPEC §7): one record per native section, keyed by
 * `sectionId`, with the name mirrored from BB. A workstream bound to a topic
 * takes its description and aliases from that topic, so what a workstream is
 * about is written in one place, the Topics tab. A section with no topic
 * keeps its own stored description. Projects and activity are refreshed
 * deterministically from live threads.
 */
import type { Database } from "./db.ts";
import type { InventoryThread } from "./inventory.ts";
import { buildForest } from "../domain/tree.ts";

export type MapProject = {
  projectId: string;
  role: "primary" | "secondary";
  environment: "checkout" | "worktree";
};

export type MapRecord = {
  sectionId: string;
  name: string;
  description: string | null;
  descriptionSource: "generated" | "user";
  aliases: string[];
  /** The topic the workstream belongs to, when Workstreams keeps it for one. */
  topicId: string | null;
  projects: MapProject[];
  evidence: { threadCount: number; lastActiveAt: number };
  createdBy: "user" | "workstreams";
  updatedAt: number;
};

type Row = {
  section_id: string;
  name: string | null;
  description: string | null;
  description_source: MapRecord["descriptionSource"];
  aliases: string;
  projects: string;
  topic_id: string | null;
  topic_description: string | null;
  topic_aliases: string | null;
  evidence: string;
  created_by: MapRecord["createdBy"];
  updated_at: number;
};

const parse = <T>(json: string, fallback: T): T => {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
};

export class WorkstreamMap {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  list(): MapRecord[] {
    return (
      this.db
        .prepare(
          `SELECT w.*, s.name, e.id AS topic_id, e.description AS topic_description, e.aliases AS topic_aliases
           FROM ws_workstream w
           JOIN ws_seen_section s ON s.section_id = w.section_id
           LEFT JOIN ws_corpus_group g ON g.section_id = w.section_id
           LEFT JOIN ws_corpus_entity e ON e.id = g.entity_id
           ORDER BY s.name COLLATE NOCASE`,
        )
        .all() as Row[]
    ).map((row) => ({
      sectionId: row.section_id,
      name: row.name ?? "",
      description: row.topic_id
        ? row.topic_description || null
        : row.description,
      descriptionSource: row.description_source,
      aliases: row.topic_id
        ? parse(row.topic_aliases ?? "[]", [])
        : parse(row.aliases, []),
      topicId: row.topic_id,
      projects: parse(row.projects, []),
      evidence: {
        threadCount: 0,
        lastActiveAt: 0,
        ...parse<Partial<MapRecord["evidence"]>>(row.evidence, {}),
      },
      createdBy: row.created_by,
      updatedAt: row.updated_at,
    }));
  }

  get(sectionId: string): MapRecord | undefined {
    return this.list().find((record) => record.sectionId === sectionId);
  }

  /**
   * Deterministic evidence from live roots: thread counts, last activity,
   * and the projects the work runs in.
   */
  refresh(threads: readonly InventoryThread[]): void {
    const forest = buildForest(threads);
    const bySection = new Map<string, InventoryThread[]>();
    for (const root of forest.roots) {
      const sectionId = root.thread.sectionId;
      if (!sectionId) continue;
      bySection.set(sectionId, [
        ...(bySection.get(sectionId) ?? []),
        root.thread,
      ]);
    }
    const update = this.db.prepare(
      `UPDATE ws_workstream SET projects = @projects, evidence = @evidence
       WHERE section_id = @id`,
    );
    const tx = this.db.transaction(() => {
      for (const record of this.list()) {
        const roots = bySection.get(record.sectionId) ?? [];
        const members = roots.flatMap((root) => [
          root,
          ...threads.filter(
            (t) => forest.rootOf.get(t.id)?.id === root.id && t.id !== root.id,
          ),
        ]);
        // Delegates count too: a coordinating root often runs in one project
        // while the code work its children do runs in another.
        const projects = rank(members.map((thread) => thread.projectId)).map(
          (projectId, i): MapProject => {
            const previous = record.projects.find(
              (p) => p.projectId === projectId,
            );
            return {
              projectId,
              role: i === 0 ? "primary" : "secondary",
              environment: previous?.environment ?? "checkout",
            };
          },
        );
        update.run({
          id: record.sectionId,
          projects: JSON.stringify(projects),
          evidence: JSON.stringify({
            threadCount: members.length,
            lastActiveAt: Math.max(
              0,
              ...members.map((t) => t.latestAttentionAt),
            ),
          }),
        });
      }
    });
    tx();
  }
}

/** Distinct non-empty values, most frequent first. */
function rank(values: readonly (string | null)[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values)
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value);
}
