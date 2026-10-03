import { corpusLabel } from "../domain/corpus-label.ts";
import {
  entityAncestors,
  type AssignmentProvenance,
  type CanonicalAssignment,
  type CatalogState,
  type CorpusEntity,
  type DraftSubjectProposal,
} from "../domain/corpus.ts";
import { randomUUID } from "node:crypto";
import { getMeta, setMeta, type Database } from "./db.ts";

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

  revision(): number {
    const raw = getMeta(this.db, "catalog_revision");
    return raw ? parseInt(raw, 10) || 1 : 1;
  }

  bumpRevision(): number {
    const next = this.revision() + 1;
    setMeta(this.db, "catalog_revision", String(next));
    return next;
  }

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

  getById(id: string): CorpusEntity | null {
    return this.list().find((entity) => entity.id === id) ?? null;
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
          this.bindGroupWithoutRevision(record.sectionId, entity.id);
          continue;
        }
        const discovered = this.rememberInternal(
          record.name,
          record.description,
          null,
          record.aliases,
        );
        this.bindGroupWithoutRevision(record.sectionId, discovered.id);
      }
      this.bumpRevision();
    });
    seed();
  }

  reset(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM ws_corpus_subject").run();
      this.db.prepare("DELETE FROM ws_corpus_group").run();
      this.db.prepare("UPDATE ws_corpus_entity SET parent_id = NULL").run();
      this.db.prepare("DELETE FROM ws_corpus_entity").run();
      this.bumpRevision();
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
        if (entity) this.bindGroupWithoutRevision(record.sectionId, entity.id);
      }
      this.bumpRevision();
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

  private rememberInternal(
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

  remember(
    name: string,
    description: string,
    parentId: string | null = null,
    aliases: readonly string[] = [],
  ): CorpusEntity {
    const entity = this.rememberInternal(name, description, parentId, aliases);
    this.bumpRevision();
    return entity;
  }

  rememberProposal(proposal: DraftSubjectProposal): CorpusEntity {
    return this.db.transaction(() => {
      let parent = proposal.parentId ?? null;
      for (const ancestor of proposal.ancestors ?? [])
        parent = this.rememberInternal(
          ancestor.name,
          ancestor.description,
          parent,
        ).id;
      const entity = this.rememberInternal(
        proposal.name,
        proposal.description,
        parent,
      );
      this.bumpRevision();
      return entity;
    })();
  }

  private bindGroupWithoutRevision(sectionId: string, entityId: string): void {
    if (!this.getById(entityId))
      throw new Error(`Unknown corpus entity: ${entityId}`);
    this.db
      .prepare(
        "INSERT INTO ws_corpus_group(section_id, entity_id) VALUES (?, ?) ON CONFLICT(section_id) DO UPDATE SET entity_id = excluded.entity_id",
      )
      .run(sectionId, entityId);
  }

  bindGroup(sectionId: string, entityId: string): void {
    this.bindGroupWithoutRevision(sectionId, entityId);
    this.bumpRevision();
  }

  unbindGroup(sectionId: string): void {
    const res = this.db
      .prepare("DELETE FROM ws_corpus_group WHERE section_id = ?")
      .run(sectionId);
    if (res.changes > 0) {
      this.bumpRevision();
    }
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

  findRootThread(threadId: string): string {
    const lookup = this.db.prepare(
      "SELECT parent_thread_id FROM ws_seen_thread WHERE thread_id = ?",
    );
    let currentId = threadId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const row = lookup.get(currentId) as
        { parent_thread_id: string | null } | undefined;
      if (!row || !row.parent_thread_id) break;
      currentId = row.parent_thread_id;
    }
    return currentId;
  }

  assignment(threadId: string): CanonicalAssignment {
    const rootId = this.findRootThread(threadId);
    const isChild = rootId !== threadId;
    const row = this.db
      .prepare(
        "SELECT entity_id, evidence, source FROM ws_corpus_subject WHERE thread_id = ?",
      )
      .get(rootId) as
      | { entity_id: string; evidence: string | null; source: string }
      | undefined;

    if (!row) {
      return {
        threadId,
        entityId: null,
        status: "unresolved",
        provenance: null,
        label: null,
        ancestorIds: [],
        evidence: null,
        inheritedFrom: isChild ? rootId : null,
      };
    }

    const entities = this.list();
    const entity = entities.find((e) => e.id === row.entity_id);
    if (!entity) {
      return {
        threadId,
        entityId: null,
        status: "unresolved",
        provenance: null,
        label: null,
        ancestorIds: [],
        evidence: null,
        inheritedFrom: isChild ? rootId : null,
      };
    }

    const provenance: AssignmentProvenance =
      row.source === "manual" || row.source === "selected"
        ? "manual"
        : "automatic";

    return {
      threadId,
      entityId: entity.id,
      status: "assigned",
      provenance,
      label: corpusLabel(entity.id, entities),
      ancestorIds: entityAncestors(entity.id, entities),
      evidence: row.evidence ?? null,
      inheritedFrom: isChild ? rootId : null,
    };
  }

  assignments(): Record<string, CanonicalAssignment> {
    const entities = this.list();
    const byId = new Map(entities.map((e) => [e.id, e]));

    const subjects = new Map<
      string,
      { entityId: string; evidence: string | null; source: string }
    >();
    const subjectRows = this.db
      .prepare(
        "SELECT thread_id, entity_id, evidence, source FROM ws_corpus_subject",
      )
      .all() as {
      thread_id: string;
      entity_id: string;
      evidence: string | null;
      source: string;
    }[];
    for (const row of subjectRows) {
      subjects.set(row.thread_id, {
        entityId: row.entity_id,
        evidence: row.evidence,
        source: row.source,
      });
    }

    const seenRows = this.db
      .prepare("SELECT thread_id, parent_thread_id FROM ws_seen_thread")
      .all() as { thread_id: string; parent_thread_id: string | null }[];
    const parentMap = new Map<string, string | null>();
    for (const row of seenRows) {
      parentMap.set(row.thread_id, row.parent_thread_id);
    }

    const resolveRoot = (id: string) => {
      let current = id;
      const visited = new Set<string>();
      while (current && !visited.has(current)) {
        visited.add(current);
        const parent = parentMap.get(current);
        if (!parent) break;
        current = parent;
      }
      return current;
    };

    const threadIds = new Set<string>([
      ...parentMap.keys(),
      ...subjects.keys(),
    ]);

    const result: Record<string, CanonicalAssignment> = {};
    for (const threadId of threadIds) {
      const rootId = resolveRoot(threadId);
      const isChild = rootId !== threadId;
      const subject = subjects.get(rootId);
      if (!subject) {
        result[threadId] = {
          threadId,
          entityId: null,
          status: "unresolved",
          provenance: null,
          label: null,
          ancestorIds: [],
          evidence: null,
          inheritedFrom: isChild ? rootId : null,
        };
        continue;
      }
      const entity = byId.get(subject.entityId);
      if (!entity) {
        result[threadId] = {
          threadId,
          entityId: null,
          status: "unresolved",
          provenance: null,
          label: null,
          ancestorIds: [],
          evidence: null,
          inheritedFrom: isChild ? rootId : null,
        };
        continue;
      }
      const provenance: AssignmentProvenance =
        subject.source === "manual" || subject.source === "selected"
          ? "manual"
          : "automatic";
      result[threadId] = {
        threadId,
        entityId: entity.id,
        status: "assigned",
        provenance,
        label: corpusLabel(entity.id, entities),
        ancestorIds: entityAncestors(entity.id, entities),
        evidence: subject.evidence ?? null,
        inheritedFrom: isChild ? rootId : null,
      };
    }
    return result;
  }

  assign(
    threadId: string,
    entityId: string,
    optionsOrEvidence?:
      string | { provenance?: AssignmentProvenance; evidence?: string },
  ): CanonicalAssignment {
    if (!this.getById(entityId))
      throw new Error(`Unknown corpus entity: ${entityId}`);
    if (!threadId.trim()) throw new Error("Thread ID must not be empty");

    const rootId = this.findRootThread(threadId);

    let provenance: AssignmentProvenance = "manual";
    let evidence: string | null = null;
    if (typeof optionsOrEvidence === "string") {
      evidence = optionsOrEvidence;
      provenance = "automatic";
    } else if (optionsOrEvidence) {
      provenance =
        optionsOrEvidence.provenance ??
        (optionsOrEvidence.evidence ? "automatic" : "manual");
      evidence = optionsOrEvidence.evidence ?? null;
    }

    this.db
      .prepare(
        `INSERT INTO ws_corpus_subject(thread_id, entity_id, evidence, source)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           entity_id = excluded.entity_id,
           evidence = excluded.evidence,
           source = excluded.source`,
      )
      .run(rootId, entityId, evidence, provenance);

    this.bumpRevision();
    return this.assignment(threadId);
  }

  clear(threadId: string): CanonicalAssignment {
    const rootId = this.findRootThread(threadId);
    this.db
      .prepare("DELETE FROM ws_corpus_subject WHERE thread_id = ?")
      .run(rootId);
    this.bumpRevision();
    return this.assignment(threadId);
  }

  reclassify(
    threadId: string,
    entityId: string | null,
    evidence?: string,
  ): CanonicalAssignment {
    if (entityId === null) {
      return this.clear(threadId);
    }
    return this.assign(threadId, entityId, {
      provenance: "automatic",
      evidence,
    });
  }

  unassign(threadId: string): void {
    this.clear(threadId);
  }

  isFresh(threadId: string, evidence: string): boolean {
    const rootId = this.findRootThread(threadId);
    const row = this.db
      .prepare(
        "SELECT evidence, source FROM ws_corpus_subject WHERE thread_id = ?",
      )
      .get(rootId) as { evidence: string | null; source: string } | undefined;
    return (
      row?.source === "manual" ||
      row?.source === "selected" ||
      ((row?.source === "automatic" || row?.source === "classified") &&
        row.evidence === evidence)
    );
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

  rename(entityId: string, newName: string): CorpusEntity {
    const cleanName = newName.trim();
    if (!cleanName) throw new Error("Entity name must not be empty");
    const entity = this.getById(entityId);
    if (!entity) throw new Error(`Unknown corpus entity: ${entityId}`);
    if (normalize(entity.name) === normalize(cleanName)) {
      if (entity.name !== cleanName) {
        this.db
          .prepare("UPDATE ws_corpus_entity SET name = ? WHERE id = ?")
          .run(cleanName, entity.id);
        this.bumpRevision();
      }
      return { ...entity, name: cleanName };
    }

    const conflict = this.resolve(cleanName, entity.parentId);
    if (conflict && conflict.id !== entityId) {
      throw new Error(
        `Corpus entity name conflicts with an existing identity in this parent scope: ${cleanName}`,
      );
    }

    const updatedAliases = cleanAliases(
      entity.aliases.filter((a) => normalize(a) !== normalize(cleanName)),
    );

    this.db
      .prepare("UPDATE ws_corpus_entity SET name = ?, aliases = ? WHERE id = ?")
      .run(cleanName, JSON.stringify(updatedAliases), entity.id);

    this.bumpRevision();
    return { ...entity, name: cleanName, aliases: updatedAliases };
  }

  reparent(entityId: string, newParentId: string | null): CorpusEntity {
    const entity = this.getById(entityId);
    if (!entity) throw new Error(`Unknown corpus entity: ${entityId}`);
    if (entity.parentId === newParentId) return entity;
    if (newParentId === entityId)
      throw new Error("Cannot reparent an entity under itself");

    if (newParentId !== null) {
      const parent = this.getById(newParentId);
      if (!parent) throw new Error(`Unknown corpus parent: ${newParentId}`);
      const parentAncestors = entityAncestors(newParentId, this.list());
      if (parentAncestors.includes(entityId)) {
        throw new Error(
          `Cannot reparent: entity ${entityId} is an ancestor of ${newParentId} (cycle detected)`,
        );
      }
    }

    const conflict = this.resolve(entity.name, newParentId);
    if (conflict && conflict.id !== entityId) {
      throw new Error(
        `Corpus entity name conflicts with an existing identity in target parent scope: ${entity.name}`,
      );
    }

    for (const alias of entity.aliases) {
      const other = this.resolve(alias, newParentId);
      if (other && other.id !== entityId) {
        throw new Error(
          `Corpus alias '${alias}' conflicts with an existing identity in target parent scope`,
        );
      }
    }

    this.db
      .prepare("UPDATE ws_corpus_entity SET parent_id = ? WHERE id = ?")
      .run(newParentId, entity.id);

    this.bumpRevision();
    return { ...entity, parentId: newParentId };
  }

  merge(
    sourceEntityId: string,
    targetEntityId: string,
  ): {
    target: CorpusEntity;
    affectedThreads: number;
    reparentedChildren: number;
  } {
    if (sourceEntityId === targetEntityId) {
      throw new Error("Cannot merge an entity into itself");
    }
    const source = this.getById(sourceEntityId);
    if (!source) throw new Error(`Unknown source entity: ${sourceEntityId}`);
    const target = this.getById(targetEntityId);
    if (!target) throw new Error(`Unknown target entity: ${targetEntityId}`);

    return this.db.transaction(() => {
      const entities = this.list();
      const targetAncestors = entityAncestors(target.id, entities);
      const targetIsDescendantOfSource = targetAncestors.includes(source.id);

      const children = entities.filter((e) => e.parentId === source.id);
      let reparentedCount = 0;
      for (const child of children) {
        if (child.id === target.id) continue;
        const existingChild = entities.find(
          (e) =>
            e.parentId === target.id &&
            normalize(e.name) === normalize(child.name) &&
            e.id !== child.id,
        );
        if (existingChild) {
          this.db
            .prepare(
              "UPDATE ws_corpus_subject SET entity_id = ? WHERE entity_id = ?",
            )
            .run(existingChild.id, child.id);
          this.db
            .prepare("DELETE FROM ws_corpus_group WHERE entity_id = ?")
            .run(child.id);
          this.db
            .prepare("DELETE FROM ws_corpus_entity WHERE id = ?")
            .run(child.id);
        } else {
          this.db
            .prepare("UPDATE ws_corpus_entity SET parent_id = ? WHERE id = ?")
            .run(target.id, child.id);
          reparentedCount++;
        }
      }

      if (targetIsDescendantOfSource) {
        this.db
          .prepare("UPDATE ws_corpus_entity SET parent_id = ? WHERE id = ?")
          .run(source.parentId, target.id);
      }

      const subjectUpdate = this.db
        .prepare(
          "UPDATE ws_corpus_subject SET entity_id = ? WHERE entity_id = ?",
        )
        .run(target.id, source.id);
      const affectedThreads = subjectUpdate.changes;

      const existingTargetGroup = this.db
        .prepare("SELECT section_id FROM ws_corpus_group WHERE entity_id = ?")
        .get(target.id) as { section_id: string } | undefined;

      if (existingTargetGroup) {
        this.db
          .prepare("DELETE FROM ws_corpus_group WHERE entity_id = ?")
          .run(source.id);
      } else {
        this.db
          .prepare(
            "UPDATE ws_corpus_group SET entity_id = ? WHERE entity_id = ?",
          )
          .run(target.id, source.id);
      }

      const combinedAliases = cleanAliases([
        ...target.aliases,
        source.name,
        ...source.aliases,
      ]).filter((a) => normalize(a) !== normalize(target.name));

      this.db
        .prepare("UPDATE ws_corpus_entity SET aliases = ? WHERE id = ?")
        .run(JSON.stringify(combinedAliases), target.id);

      this.db
        .prepare("DELETE FROM ws_corpus_entity WHERE id = ?")
        .run(source.id);

      this.bumpRevision();

      const updatedTarget: CorpusEntity = {
        ...target,
        parentId: targetIsDescendantOfSource
          ? source.parentId
          : target.parentId,
        aliases: combinedAliases,
      };

      return {
        target: updatedTarget,
        affectedThreads,
        reparentedChildren: reparentedCount,
      };
    })();
  }

  state(): CatalogState {
    const entities = this.list();
    const groups: Record<string, string> = {};
    for (const [sectionId, entityId] of this.groups()) {
      groups[sectionId] = entityId;
    }
    return {
      entities,
      groups,
      assignments: this.assignments(),
      revision: this.revision(),
    };
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
