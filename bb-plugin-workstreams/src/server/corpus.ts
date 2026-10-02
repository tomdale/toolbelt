import { corpusLabel } from "../domain/corpus-label.ts";
import { randomUUID } from "node:crypto";
import type { CorpusEntity } from "../domain/corpus.ts";
import type { Database } from "./db.ts";

export type CorpusSeed = {
  readonly sectionId: string;
  readonly name: string;
  readonly description: string;
  readonly aliases: readonly string[];
};

const normalize = (value: string) => value.trim().toLowerCase();
const cleanAliases = (aliases: readonly string[]) => [
  ...new Set(aliases.map((alias) => alias.trim()).filter(Boolean)),
];

export class CorpusStore {
  constructor(private readonly db: Database) {}

  list(): CorpusEntity[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, description, parent_id, aliases FROM ws_corpus_entity ORDER BY id",
      )
      .all() as {
      id: string;
      name: string;
      description: string;
      parent_id: string | null;
      aliases: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      parentId: row.parent_id,
      aliases: JSON.parse(row.aliases) as string[],
    }));
  }

  seed(records: readonly CorpusSeed[]): void {
    const seed = this.db.transaction(() => {
      const existing = this.groups();
      this.db.prepare("DELETE FROM ws_corpus_group").run();
      for (const record of records) {
        const linked = existing.get(record.sectionId);
        const entity = linked ? this.getById(linked) : null;
        if (entity) {
          const name = entity.name;
          const aliases = cleanAliases([
            ...entity.aliases,
            ...record.aliases,
            ...(name !== entity.name ? [entity.name] : []),
          ]).filter((alias) => normalize(alias) !== normalize(name));
          if (
            aliases.some((alias) => {
              const other = this.resolve(alias, entity.parentId);
              return other && other.id !== entity.id;
            })
          )
            throw new Error(
              "Corpus metadata aliases conflict with another identity.",
            );
          const sameName = this.resolve(name, entity.parentId);
          if (sameName && sameName.id !== entity.id)
            throw new Error(
              "Corpus metadata name conflicts with another identity.",
            );
          this.db
            .prepare(
              "UPDATE ws_corpus_entity SET name = ?, description = ?, aliases = ? WHERE id = ?",
            )
            .run(
              name,
              entity.description || record.description.trim(),
              JSON.stringify(aliases),
              entity.id,
            );
          this.bindGroup(record.sectionId, entity.id);
          continue;
        }
        const discovered = this.remember(
          record.name,
          record.description,
          null,
          record.aliases,
        );
        this.bindGroup(record.sectionId, discovered.id);
      }
    });
    seed();
  }

  reset(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM ws_corpus_subject").run();
      this.db.prepare("DELETE FROM ws_corpus_group").run();
      this.db.prepare("UPDATE ws_corpus_entity SET parent_id = NULL").run();
      this.db.prepare("DELETE FROM ws_corpus_entity").run();
    })();
  }

  /** Navigation labels can bind existing identities, never establish semantic knowledge. */
  syncGroups(records: readonly CorpusSeed[]): void {
    const entities = this.list();
    this.db.transaction(() => {
      const existing = this.groups();
      this.db.prepare("DELETE FROM ws_corpus_group").run();
      for (const record of records) {
        const entity =
          entities.find((e) => e.id === existing.get(record.sectionId)) ??
          entities.find(
            (e) =>
              normalize(corpusLabel(e.id, entities)) === normalize(record.name),
          );
        if (entity) this.bindGroup(record.sectionId, entity.id);
      }
    })();
  }

  resolve(name: string, parentId: string | null = null): CorpusEntity | null {
    const target = normalize(name);
    for (const entity of this.list()) {
      if (entity.parentId !== parentId) continue;
      if (
        normalize(entity.name) === target ||
        entity.aliases.some((alias) => normalize(alias) === target)
      )
        return entity;
    }
    return null;
  }

  remember(
    name: string,
    description: string,
    parentId: string | null = null,
    aliases: readonly string[] = [],
  ): CorpusEntity {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Corpus entity name must not be empty");
    if (parentId !== null && !this.getById(parentId))
      throw new Error(`Unknown corpus parent: ${parentId}`);
    this.assertParentChainAcyclic(parentId);

    const existing = this.resolve(cleanName, parentId);
    if (existing) {
      const discoveredAlias =
        normalize(existing.name) === normalize(cleanName) ? [] : [cleanName];
      const mergedAliases = cleanAliases([
        ...existing.aliases,
        ...discoveredAlias,
        ...aliases,
      ]);
      if (
        mergedAliases.some((alias) => {
          const other = this.resolve(alias, parentId);
          return other && other.id !== existing.id;
        })
      )
        throw new Error(
          "Corpus alias already resolves to another identity in this parent scope",
        );
      const nextDescription = description.trim() || existing.description;
      this.db
        .prepare(
          "UPDATE ws_corpus_entity SET description = ?, aliases = ? WHERE id = ?",
        )
        .run(nextDescription, JSON.stringify(mergedAliases), existing.id);
      return {
        ...existing,
        description: nextDescription,
        aliases: mergedAliases,
      };
    }

    const cleanDescription = description.trim();
    const cleanAliasList = cleanAliases(aliases);
    if (
      cleanAliasList.some((alias) => normalize(alias) === normalize(cleanName))
    )
      throw new Error("Corpus entity alias must differ from its name");
    if (cleanAliasList.some((alias) => this.resolve(alias, parentId)))
      throw new Error(
        "Corpus alias already resolves to an entity in this parent scope",
      );

    const entity: CorpusEntity = {
      id: randomUUID(),
      name: cleanName,
      description: cleanDescription,
      parentId,
      aliases: cleanAliasList,
    };
    this.db
      .prepare(
        "INSERT INTO ws_corpus_entity(id, name, description, parent_id, aliases) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        entity.id,
        entity.name,
        entity.description,
        entity.parentId,
        JSON.stringify(entity.aliases),
      );
    return entity;
  }

  rememberProposal(proposal: {
    name: string;
    description: string;
    parentId: string | null;
    ancestors?: { name: string; description: string }[];
  }): CorpusEntity {
    return this.db.transaction(() => {
      let parent = proposal.parentId;
      for (const ancestor of proposal.ancestors ?? [])
        parent = this.remember(ancestor.name, ancestor.description, parent).id;
      return this.remember(proposal.name, proposal.description, parent);
    })();
  }

  bindGroup(sectionId: string, entityId: string): void {
    if (!this.getById(entityId))
      throw new Error(`Unknown corpus entity: ${entityId}`);
    this.db
      .prepare(
        "INSERT INTO ws_corpus_group(section_id, entity_id) VALUES (?, ?) ON CONFLICT(section_id) DO UPDATE SET entity_id = excluded.entity_id",
      )
      .run(sectionId, entityId);
  }

  groups(): Map<string, string> {
    const rows = this.db
      .prepare(
        "SELECT section_id, entity_id FROM ws_corpus_group ORDER BY section_id",
      )
      .all() as { section_id: string; entity_id: string }[];
    return new Map(
      rows.map(({ section_id, entity_id }) => [section_id, entity_id]),
    );
  }

  assign(threadId: string, entityId: string, evidence?: string): void {
    if (!this.getById(entityId))
      throw new Error(`Unknown corpus entity: ${entityId}`);
    this.db
      .prepare(
        "INSERT INTO ws_corpus_subject(thread_id, entity_id, evidence, source) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET entity_id = excluded.entity_id, evidence = excluded.evidence, source = excluded.source",
      )
      .run(
        threadId,
        entityId,
        evidence ?? null,
        evidence ? "classified" : "selected",
      );
  }

  isFresh(threadId: string, evidence: string): boolean {
    const row = this.db
      .prepare(
        "SELECT evidence, source FROM ws_corpus_subject WHERE thread_id = ?",
      )
      .get(threadId) as { evidence: string | null; source: string } | undefined;
    return (
      row?.source === "selected" ||
      (row?.source === "classified" && row.evidence === evidence)
    );
  }

  unassign(threadId: string): void {
    this.db
      .prepare("DELETE FROM ws_corpus_subject WHERE thread_id = ?")
      .run(threadId);
  }

  subjects(): Map<string, string> {
    const rows = this.db
      .prepare(
        "SELECT thread_id, entity_id FROM ws_corpus_subject ORDER BY thread_id",
      )
      .all() as { thread_id: string; entity_id: string }[];
    return new Map(
      rows.map(({ thread_id, entity_id }) => [thread_id, entity_id]),
    );
  }

  private getById(id: string): CorpusEntity | null {
    return this.list().find((entity) => entity.id === id) ?? null;
  }

  private assertParentChainAcyclic(parentId: string | null): void {
    const visited = new Set<string>();
    let currentId = parentId;
    while (currentId !== null) {
      if (visited.has(currentId))
        throw new Error(`Corpus parent cycle detected at: ${currentId}`);
      visited.add(currentId);
      const current = this.getById(currentId);
      if (!current) throw new Error(`Unknown corpus parent: ${currentId}`);
      currentId = current.parentId;
    }
  }
}
