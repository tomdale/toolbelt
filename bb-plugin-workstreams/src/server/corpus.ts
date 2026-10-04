import { corpusLabel } from "../domain/corpus-label.ts";
import {
  entityAncestors,
  resolveProposal,
  type AssignmentProvenance,
  type CanonicalAssignment,
  type CatalogState,
  type CorpusEntity,
  type DraftSubjectProposal,
} from "../domain/corpus.ts";
import { createHash, randomUUID } from "node:crypto";
import { getMeta, setMeta, type Database } from "./db.ts";

export const CLASSIFICATION_VERSION = "catalog-semantics-v1";

export function classificationEvidence(input: {
  version?: string;
  requests?: readonly unknown[];
  title?: string | null;
  project?: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: input.version ?? CLASSIFICATION_VERSION,
        requests: input.requests ?? [],
        title: input.title ?? "",
        project: input.project ?? null,
      }),
    )
    .digest("hex");
}

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
  syncGroups(records: readonly CorpusSeed[]): boolean {
    const entities = this.list();
    const existing = this.groups();
    const desired = new Map<string, string>();
    for (const record of records) {
      const entity =
        entities.find((e) => e.id === existing.get(record.sectionId)) ??
        entities.find(
          (e) =>
            normalize(corpusLabel(e.id, entities)) === normalize(record.name),
        );
      if (entity) desired.set(record.sectionId, entity.id);
    }

    let changed = existing.size !== desired.size;
    if (!changed) {
      for (const [secId, entId] of desired) {
        if (existing.get(secId) !== entId) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) {
      return false;
    }

    this.db.transaction(() => {
      this.db.prepare("DELETE FROM ws_corpus_group").run();
      const insert = this.db.prepare(
        "INSERT INTO ws_corpus_group(section_id, entity_id) VALUES (?, ?)",
      );
      for (const [sectionId, entityId] of desired) {
        insert.run(sectionId, entityId);
      }
      this.bumpRevision();
    })();
    return true;
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

  create(
    name: string,
    description: string = "",
    parentId: string | null = null,
    aliases: readonly string[] = [],
  ): CorpusEntity {
    return this.db.transaction(() => {
      const cleanName = name.trim();
      if (!cleanName) throw new Error("Corpus entity name must not be empty");
      if (parentId !== null && !this.getById(parentId))
        throw new Error(`Unknown corpus parent: ${parentId}`);
      this.assertParentChainAcyclic(parentId);

      const existing = this.resolve(cleanName, parentId);
      if (existing) {
        throw new Error(
          `Corpus entity '${cleanName}' already exists in this parent scope`,
        );
      }

      const cleanDescription = description.trim();
      const cleanAliasList = cleanAliases(aliases);
      if (
        cleanAliasList.some(
          (alias) => normalize(alias) === normalize(cleanName),
        )
      )
        throw new Error("Corpus entity alias must differ from its name");

      for (const alias of cleanAliasList) {
        if (this.resolve(alias, parentId))
          throw new Error(
            `Corpus alias '${alias}' already resolves to an entity in this parent scope`,
          );
      }

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

      this.bumpRevision();
      return entity;
    })();
  }

  remember(
    name: string,
    description: string,
    parentId: string | null = null,
    aliases: readonly string[] = [],
  ): CorpusEntity {
    return this.db.transaction(() => {
      const entity = this.rememberInternal(
        name,
        description,
        parentId,
        aliases,
      );
      this.bumpRevision();
      return entity;
    })();
  }

  /**
   * Records a discovered identity under its deepest existing ancestor, resolved
   * against the Catalog as it is now: it may have changed since the proposal
   * was classified. A proposal that names an existing identity returns it
   * unchanged.
   */
  rememberProposal(draft: DraftSubjectProposal): CorpusEntity {
    return this.db.transaction(() => {
      if (draft.parentId && !this.getById(draft.parentId))
        throw new Error(`Unknown corpus parent: ${draft.parentId}`);
      const resolved = resolveProposal(draft, this.list());
      if (resolved.subjectId !== null) return this.getById(resolved.subjectId)!;
      const proposal = resolved.proposed;
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
    if (!this.getById(entityId))
      throw new Error(`Unknown corpus entity: ${entityId}`);
    const existing = this.groups().get(sectionId);
    if (existing === entityId) return;
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
      | { entity_id: string | null; evidence: string | null; source: string }
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

    const provenance: AssignmentProvenance =
      row.source === "manual" ? "manual" : "automatic";

    const entities = this.list();
    const entity = row.entity_id
      ? entities.find((e) => e.id === row.entity_id)
      : null;
    if (!entity) {
      return {
        threadId,
        entityId: null,
        status: "unresolved",
        provenance,
        label: null,
        ancestorIds: [],
        evidence: row.evidence ?? null,
        inheritedFrom: isChild ? rootId : null,
      };
    }

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
      { entityId: string | null; evidence: string | null; source: string }
    >();
    const subjectRows = this.db
      .prepare(
        "SELECT thread_id, entity_id, evidence, source FROM ws_corpus_subject",
      )
      .all() as {
      thread_id: string;
      entity_id: string | null;
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
      const entity = subject.entityId ? byId.get(subject.entityId) : null;
      const provenance: AssignmentProvenance =
        subject.source === "manual" ? "manual" : "automatic";
      if (!entity) {
        result[threadId] = {
          threadId,
          entityId: null,
          status: "unresolved",
          provenance,
          label: null,
          ancestorIds: [],
          evidence: subject.evidence ?? null,
          inheritedFrom: isChild ? rootId : null,
        };
        continue;
      }
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
    entityId: string | null,
    options?: { provenance?: AssignmentProvenance; evidence?: string | null },
  ): CanonicalAssignment {
    return this.db.transaction(() => {
      if (entityId !== null && !this.getById(entityId))
        throw new Error(`Unknown corpus entity: ${entityId}`);
      if (!threadId.trim()) throw new Error("Thread ID must not be empty");

      const rootId = this.findRootThread(threadId);

      const provenance: AssignmentProvenance =
        options?.provenance ?? (options?.evidence ? "automatic" : "manual");
      const evidence: string | null = options?.evidence ?? null;

      const existing = this.db
        .prepare(
          "SELECT entity_id, evidence, source FROM ws_corpus_subject WHERE thread_id = ?",
        )
        .get(rootId) as
        | { entity_id: string | null; evidence: string | null; source: string }
        | undefined;

      if (
        existing &&
        existing.entity_id === entityId &&
        existing.source === provenance &&
        (existing.evidence ?? null) === evidence
      ) {
        return this.assignment(threadId);
      }

      const isInitialClear =
        !existing && entityId === null && provenance === "manual";

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

      if (!isInitialClear) {
        this.bumpRevision();
      }
      return this.assignment(threadId);
    })();
  }

  clear(threadId: string): CanonicalAssignment {
    return this.assign(threadId, null, {
      provenance: "manual",
      evidence: null,
    });
  }

  reclassify(
    threadId: string,
    entityId: string | null,
    evidence?: string,
  ): CanonicalAssignment {
    return this.assign(threadId, entityId, {
      provenance: evidence ? "automatic" : "manual",
      evidence: evidence ?? null,
    });
  }

  isFresh(threadId: string, evidence: string): boolean {
    const rootId = this.findRootThread(threadId);
    const row = this.db
      .prepare(
        "SELECT evidence, source FROM ws_corpus_subject WHERE thread_id = ?",
      )
      .get(rootId) as { evidence: string | null; source: string } | undefined;
    if (!row) return false;
    return (
      row.source === "manual" ||
      (row.source === "automatic" && row.evidence === evidence)
    );
  }

  subjects(): Map<string, string> {
    const rows = this.db
      .prepare(
        "SELECT thread_id, entity_id FROM ws_corpus_subject WHERE entity_id IS NOT NULL ORDER BY thread_id",
      )
      .all() as { thread_id: string; entity_id: string }[];
    return new Map(
      rows.map(({ thread_id, entity_id }) => [thread_id, entity_id]),
    );
  }

  edit(
    entityId: string,
    updates: {
      name?: string;
      description?: string;
      aliases?: readonly string[];
    },
  ): CorpusEntity {
    return this.db.transaction(() => {
      const entity = this.getById(entityId);
      if (!entity) throw new Error(`Unknown corpus entity: ${entityId}`);

      let cleanName = entity.name;
      if (updates.name !== undefined) {
        cleanName = updates.name.trim();
        if (!cleanName) throw new Error("Entity name must not be empty");
        if (normalize(entity.name) !== normalize(cleanName)) {
          const conflict = this.resolve(cleanName, entity.parentId);
          if (conflict && conflict.id !== entityId) {
            throw new Error(
              `Corpus entity name conflicts with an existing identity in this parent scope: ${cleanName}`,
            );
          }
        }
      }

      let nextDescription = entity.description;
      if (updates.description !== undefined) {
        nextDescription = updates.description.trim();
      }

      let nextAliases = entity.aliases;
      if (updates.aliases !== undefined) {
        const cleanAliasList = cleanAliases(updates.aliases);
        if (
          cleanAliasList.some(
            (alias) => normalize(alias) === normalize(cleanName),
          )
        ) {
          throw new Error("Corpus entity alias must differ from its name");
        }
        if (
          cleanAliasList.some((alias) => {
            const other = this.resolve(alias, entity.parentId);
            return other && other.id !== entity.id;
          })
        ) {
          throw new Error(
            "Corpus alias already resolves to an entity in this parent scope",
          );
        }
        nextAliases = cleanAliasList;
      } else if (updates.name !== undefined) {
        nextAliases = cleanAliases(
          entity.aliases.filter((a) => normalize(a) !== normalize(cleanName)),
        );
      }

      const nameChanged = cleanName !== entity.name;
      const descriptionChanged = nextDescription !== entity.description;
      const aliasesChanged =
        nextAliases.length !== entity.aliases.length ||
        nextAliases.some((a, i) => a !== entity.aliases[i]);

      if (!nameChanged && !descriptionChanged && !aliasesChanged) {
        return entity;
      }

      this.db
        .prepare(
          "UPDATE ws_corpus_entity SET name = ?, description = ?, aliases = ? WHERE id = ?",
        )
        .run(cleanName, nextDescription, JSON.stringify(nextAliases), entity.id);

      this.bumpRevision();
      return {
        ...entity,
        name: cleanName,
        description: nextDescription,
        aliases: nextAliases,
      };
    })();
  }

  rename(entityId: string, newName: string): CorpusEntity {
    return this.edit(entityId, { name: newName });
  }

  reparent(entityId: string, newParentId: string | null): CorpusEntity {
    return this.db.transaction(() => {
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
    })();
  }

  updateMetadata(
    entityId: string,
    updates: { description?: string; aliases?: readonly string[] },
  ): CorpusEntity {
    return this.edit(entityId, updates);
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

    return this.db.transaction(() => {
      const source = this.getById(sourceEntityId);
      if (!source) throw new Error(`Unknown source entity: ${sourceEntityId}`);
      const target = this.getById(targetEntityId);
      if (!target) throw new Error(`Unknown target entity: ${targetEntityId}`);

      const entities = this.list();
      const targetAncestors = entityAncestors(target.id, entities);
      const targetIsDescendantOfSource = targetAncestors.includes(source.id);

      const newTargetParentId = targetIsDescendantOfSource
        ? source.parentId
        : target.parentId;

      // Validate newTargetParentId
      if (newTargetParentId !== null) {
        const newParent = this.getById(newTargetParentId);
        if (!newParent)
          throw new Error(`Unknown corpus parent: ${newTargetParentId}`);
      }

      const combinedAliases = cleanAliases([
        ...target.aliases,
        source.name,
        ...source.aliases,
      ]).filter((a) => normalize(a) !== normalize(target.name));

      // Sibling validation in target's final parent scope:
      // None of target's final aliases or target.name may conflict with other siblings in that scope.
      const targetSiblings = this.list().filter(
        (e) =>
          e.parentId === newTargetParentId &&
          e.id !== target.id &&
          e.id !== source.id,
      );

      for (const sibling of targetSiblings) {
        if (normalize(sibling.name) === normalize(target.name)) {
          throw new Error(
            `Corpus entity name conflicts with an existing identity in target parent scope: ${target.name}`,
          );
        }
        if (
          sibling.aliases.some((a) => normalize(a) === normalize(target.name))
        ) {
          throw new Error(
            `Corpus entity name conflicts with an existing alias in target parent scope: ${target.name}`,
          );
        }
        for (const alias of combinedAliases) {
          if (
            normalize(sibling.name) === normalize(alias) ||
            sibling.aliases.some((a) => normalize(a) === normalize(alias))
          ) {
            throw new Error(
              `Corpus alias '${alias}' conflicts with an existing identity in target parent scope`,
            );
          }
        }
      }

      let totalAffectedThreads = 0;
      let totalReparentedChildren = 0;

      // If target is descendant of source, reparent target to source.parentId before processing source's subtree
      if (targetIsDescendantOfSource) {
        this.db
          .prepare("UPDATE ws_corpus_entity SET parent_id = ? WHERE id = ?")
          .run(source.parentId, target.id);
      }

      const mergeSubtree = (src: CorpusEntity, dst: CorpusEntity) => {
        // 1. Move subjects assigned to src -> dst
        const subjectUpdate = this.db
          .prepare(
            "UPDATE ws_corpus_subject SET entity_id = ? WHERE entity_id = ?",
          )
          .run(dst.id, src.id);
        totalAffectedThreads += subjectUpdate.changes;

        // 2. Handle group bindings
        const dstGroup = this.db
          .prepare("SELECT section_id FROM ws_corpus_group WHERE entity_id = ?")
          .get(dst.id) as { section_id: string } | undefined;
        if (dstGroup) {
          this.db
            .prepare("DELETE FROM ws_corpus_group WHERE entity_id = ?")
            .run(src.id);
        } else {
          this.db
            .prepare(
              "UPDATE ws_corpus_group SET entity_id = ? WHERE entity_id = ?",
            )
            .run(dst.id, src.id);
        }

        // 3. Merge aliases
        const mergedDstAliases = cleanAliases([
          ...dst.aliases,
          src.name,
          ...src.aliases,
        ]).filter((a) => normalize(a) !== normalize(dst.name));

        // Validate mergedDstAliases against siblings in dst.parentId scope
        const siblings = this.list().filter(
          (e) =>
            e.parentId === dst.parentId && e.id !== dst.id && e.id !== src.id,
        );
        for (const sibling of siblings) {
          for (const alias of mergedDstAliases) {
            if (
              normalize(sibling.name) === normalize(alias) ||
              sibling.aliases.some((a) => normalize(a) === normalize(alias))
            ) {
              throw new Error(
                `Corpus alias '${alias}' conflicts with an existing identity in target parent scope`,
              );
            }
          }
        }

        this.db
          .prepare("UPDATE ws_corpus_entity SET aliases = ? WHERE id = ?")
          .run(JSON.stringify(mergedDstAliases), dst.id);

        // 4. Process children of src
        const srcChildren = this.list().filter((e) => e.parentId === src.id);
        for (const child of srcChildren) {
          if (child.id === dst.id) continue;

          const dstChildren = this.list().filter((e) => e.parentId === dst.id);
          const matchingDstChild = dstChildren.find(
            (e) =>
              normalize(e.name) === normalize(child.name) && e.id !== child.id,
          );

          if (matchingDstChild) {
            // Recursively merge child into matchingDstChild!
            mergeSubtree(child, matchingDstChild);
          } else {
            // Validate child name and aliases against existing dst children
            for (const existingDstChild of dstChildren) {
              if (
                normalize(existingDstChild.name) === normalize(child.name) ||
                existingDstChild.aliases.some(
                  (a) => normalize(a) === normalize(child.name),
                )
              ) {
                throw new Error(
                  `Corpus entity name conflicts with an existing identity in target parent scope: ${child.name}`,
                );
              }
              for (const alias of child.aliases) {
                if (
                  normalize(existingDstChild.name) === normalize(alias) ||
                  existingDstChild.aliases.some(
                    (a) => normalize(a) === normalize(alias),
                  )
                ) {
                  throw new Error(
                    `Corpus alias '${alias}' conflicts with an existing identity in target parent scope`,
                  );
                }
              }
            }

            // Reparent child under dst
            this.db
              .prepare("UPDATE ws_corpus_entity SET parent_id = ? WHERE id = ?")
              .run(dst.id, child.id);
            totalReparentedChildren++;
          }
        }

        // 5. Delete src
        this.db
          .prepare("DELETE FROM ws_corpus_entity WHERE id = ?")
          .run(src.id);
      };

      mergeSubtree(source, target);

      // Verify acyclic invariant across all entities
      for (const e of this.list()) {
        this.assertParentChainAcyclic(e.id);
      }

      this.bumpRevision();

      const updatedTarget = this.getById(target.id)!;
      return {
        target: updatedTarget,
        affectedThreads: totalAffectedThreads,
        reparentedChildren: totalReparentedChildren,
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
