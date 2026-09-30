/**
 * The workstream map (SPEC §7): one record per native section, keyed by
 * `sectionId`, with the name mirrored from BB. Evidence and subjects are
 * refreshed deterministically from live threads and analysis; a description
 * the user wrote always wins over a generated one.
 */
import type { StoredAnalysis } from "./analyzer.ts";
import type { Database } from "./db.ts";
import type { InventoryThread } from "./inventory.ts";
import { buildForest } from "../domain/tree.ts";
import type { ProductConcept } from "../domain/analysis.ts";

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
  subjects: string[];
  /** Bounded, concrete product concepts supporting routing evidence. */
  concepts: ProductConcept[];
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
  subjects: string;
  concepts: string;
  projects: string;
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

const SUBJECTS_MAX = 12;

export class WorkstreamMap {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  list(): MapRecord[] {
    return (
      this.db
        .prepare(
          `SELECT w.*, s.name FROM ws_workstream w
           JOIN ws_seen_section s ON s.section_id = w.section_id
           ORDER BY s.name COLLATE NOCASE`,
        )
        .all() as Row[]
    ).map((row) => ({
      sectionId: row.section_id,
      name: row.name ?? "",
      description: row.description,
      descriptionSource: row.description_source,
      aliases: parse(row.aliases, []),
      subjects: parse(row.subjects, []),
      concepts: parse(row.concepts, []),
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

  /** A user edit; the description then stays theirs (SPEC §7). */
  edit(
    sectionId: string,
    patch: { description?: string | null; aliases?: string[] },
  ): void {
    const at = this.now();
    if (patch.description !== undefined)
      this.db
        .prepare(
          `UPDATE ws_workstream SET description = ?, description_source = 'user', updated_at = ? WHERE section_id = ?`,
        )
        .run(patch.description?.trim() || null, at, sectionId);
    if (patch.aliases !== undefined)
      this.db
        .prepare(
          "UPDATE ws_workstream SET aliases = ?, updated_at = ? WHERE section_id = ?",
        )
        .run(
          JSON.stringify(
            [
              ...new Set(patch.aliases.map((a) => a.trim()).filter(Boolean)),
            ].slice(0, 20),
          ),
          at,
          sectionId,
        );
  }

  /** Stores a generated description unless the user wrote one. */
  describe(sectionId: string, description: string): void {
    this.db
      .prepare(
        `UPDATE ws_workstream SET description = ?, updated_at = ?
         WHERE section_id = ? AND description_source = 'generated'`,
      )
      .run(description, this.now(), sectionId);
  }

  /**
   * Deterministic evidence from live roots: thread counts, last activity,
   * the projects the work runs in, and the subjects analysis found.
   */
  refresh(
    threads: readonly InventoryThread[],
    analysis: Readonly<Record<string, StoredAnalysis>>,
  ): void {
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
      `UPDATE ws_workstream SET subjects = @subjects, projects = @projects, evidence = @evidence
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
        const subjects = rank(
          roots.map((root) => analysis[root.id]?.subject ?? null),
        ).slice(0, SUBJECTS_MAX);
        const concepts = rankConcepts(
          roots.flatMap((root) => analysis[root.id]?.concepts ?? []),
        );
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
          subjects: JSON.stringify(subjects),
          concepts: JSON.stringify(concepts),
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

const CONCEPTS_MAX = 8;
const CONCEPT_TERMS_MAX = 4;

function rankConcepts(values: readonly ProductConcept[]): ProductConcept[] {
  const counts = new Map<string, { concept: ProductConcept; count: number }>();
  for (const concept of values) {
    const name = concept.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const current = counts.get(key);
    const terms = [...new Set(concept.terms.map((term) => term.trim()).filter(Boolean))].slice(0, CONCEPT_TERMS_MAX);
    if (!current) counts.set(key, { concept: { name, terms }, count: 1 });
    else {
      current.count++;
      current.concept = {
        name: current.concept.name,
        terms: [...new Set([...current.concept.terms, ...terms])].slice(0, CONCEPT_TERMS_MAX),
      };
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.concept.name.localeCompare(b.concept.name))
    .slice(0, CONCEPTS_MAX)
    .map(({ concept }) => concept);
}
