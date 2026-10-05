import { topicPath } from "../domain/topic-path.ts";
import {
  topicAncestors,
  resolveProposal,
  type AssignmentProvenance,
  type TopicAssignment,
  type TopicState,
  type Topic,
  type DraftSubjectProposal,
} from "../domain/topics.ts";
import { createHash, randomUUID } from "node:crypto";
import { getMeta, setMeta, type Database } from "./db.ts";

/** Bump to settle every thread's topic again with changed classification rules. */
export const CLASSIFICATION_VERSION = "topics-v2";

/**
 * The basis of an automatic topic: what it was classified from. Only the
 * user's requests and the project decide a topic, so a retitle never makes a
 * topic stale.
 */
export function topicBasis(input: {
  version?: string;
  requests?: readonly unknown[];
  project?: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: input.version ?? CLASSIFICATION_VERSION,
        requests: input.requests ?? [],
        project: input.project ?? null,
      }),
    )
    .digest("hex");
}

const readSource = (source: string): AssignmentProvenance =>
  source === "manual" || source === "inherited" || source === "quick"
    ? source
    : "full";

const normalize = (value: string) => value.trim().toLowerCase();
const cleanAliases = (aliases: readonly string[]) => [
  ...new Set(aliases.map((alias) => alias.trim()).filter(Boolean)),
];

export class TopicStore {
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

  list(): Topic[] {
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

  getById(id: string): Topic | null {
    return this.list().find((entity) => entity.id === id) ?? null;
  }

  resolve(name: string, parentId: string | null = null): Topic | null {
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
  ): Topic {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Topic name must not be empty");
    if (parentId !== null && !this.getById(parentId))
      throw new Error(`Unknown topic parent: ${parentId}`);
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
          "Topic alias already resolves to another topic in this parent scope",
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
      throw new Error("Topic alias must differ from its name");
    if (cleanAliasList.some((alias) => this.resolve(alias, parentId)))
      throw new Error(
        "Topic alias already resolves to an entity in this parent scope",
      );

    const entity: Topic = {
      id: randomUUID(),
      name: cleanName,
      description: cleanDescription,
      parentId,
      aliases: cleanAliasList,
    };
    this.db
      .prepare(
        "INSERT INTO ws_corpus_entity(id, name, description, parent_id, aliases, origin) VALUES (?, ?, ?, ?, ?, 'discovered')",
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
  ): Topic {
    return this.db.transaction(() => {
      const cleanName = name.trim();
      if (!cleanName) throw new Error("Topic name must not be empty");
      if (parentId !== null && !this.getById(parentId))
        throw new Error(`Unknown topic parent: ${parentId}`);
      this.assertParentChainAcyclic(parentId);

      const existing = this.resolve(cleanName, parentId);
      if (existing) {
        throw new Error(
          `Topic '${cleanName}' already exists in this parent scope`,
        );
      }

      const cleanDescription = description.trim();
      const cleanAliasList = cleanAliases(aliases);
      if (
        cleanAliasList.some(
          (alias) => normalize(alias) === normalize(cleanName),
        )
      )
        throw new Error("Topic alias must differ from its name");

      for (const alias of cleanAliasList) {
        if (this.resolve(alias, parentId))
          throw new Error(
            `Topic alias '${alias}' already resolves to an entity in this parent scope`,
          );
      }

      const entity: Topic = {
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
  ): Topic {
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
   * Records a discovered topic under its deepest existing ancestor, resolved
   * against the Catalog as it is now: it may have changed since the proposal
   * was classified. A proposal that names an existing topic returns it
   * unchanged.
   */
  rememberProposal(draft: DraftSubjectProposal): Topic {
    return this.db.transaction(() => {
      if (draft.parentId && !this.getById(draft.parentId))
        throw new Error(`Unknown topic parent: ${draft.parentId}`);
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
      throw new Error(`Unknown topic: ${entityId}`);
    this.db
      .prepare(
        "INSERT INTO ws_corpus_group(section_id, entity_id) VALUES (?, ?) ON CONFLICT(section_id) DO UPDATE SET entity_id = excluded.entity_id",
      )
      .run(sectionId, entityId);
  }

  bindGroup(sectionId: string, entityId: string): void {
    if (!this.getById(entityId))
      throw new Error(`Unknown topic: ${entityId}`);
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

  assignment(threadId: string): TopicAssignment {
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

    const provenance = readSource(row.source);

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
      label: topicPath(entity.id, entities),
      ancestorIds: topicAncestors(entity.id, entities),
      evidence: row.evidence ?? null,
      inheritedFrom: isChild ? rootId : null,
    };
  }

  assignments(): Record<string, TopicAssignment> {
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

    const result: Record<string, TopicAssignment> = {};
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
      const provenance = readSource(subject.source);
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
        label: topicPath(entity.id, entities),
        ancestorIds: topicAncestors(entity.id, entities),
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
  ): TopicAssignment {
    return this.db.transaction(() => {
      if (entityId !== null && !this.getById(entityId))
        throw new Error(`Unknown topic: ${entityId}`);
      if (!threadId.trim()) throw new Error("Thread ID must not be empty");

      const rootId = this.findRootThread(threadId);

      const provenance: AssignmentProvenance = options?.provenance ?? "manual";
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

  clear(threadId: string): TopicAssignment {
    return this.assign(threadId, null, {
      provenance: "manual",
      evidence: null,
    });
  }

  /**
   * Applies an analysis's topic under the source priority (see
   * `AssignmentProvenance`): your topic is never replaced, an inherited one
   * only by Full analysis on a scope shift, and Quick analysis only fills a
   * thread that has no topic yet or replaces its own earlier guess. Returns
   * whether the assignment changed.
   */
  applyAnalysis(
    threadId: string,
    answer: {
      subjectId: string | null;
      proposed: DraftSubjectProposal | null;
      scopeShift?: boolean;
    },
    kind: "full" | "quick",
    basis: string | null,
  ): boolean {
    return this.db.transaction(() => {
      const rootId = this.findRootThread(threadId);
      const row = this.db
        .prepare(
          "SELECT entity_id, evidence, source FROM ws_corpus_subject WHERE thread_id = ?",
        )
        .get(rootId) as
        | { entity_id: string | null; evidence: string | null; source: string }
        | undefined;
      const current = row ? readSource(row.source) : null;
      if (current === "manual") return false;
      if (current === "inherited" && !(kind === "full" && answer.scopeShift)) {
        // Settled from these requests: a later turn without a new request
        // has nothing to reconsider.
        if (kind === "full" && basis && row?.evidence !== basis)
          this.db
            .prepare(
              "UPDATE ws_corpus_subject SET evidence = ? WHERE thread_id = ?",
            )
            .run(basis, rootId);
        return false;
      }
      if (kind === "quick" && current !== null && current !== "quick")
        return false;
      const entity = answer.subjectId
        ? this.getById(answer.subjectId)
        : answer.proposed
          ? this.rememberProposal(answer.proposed)
          : null;
      const entityId = entity?.id ?? null;
      if (
        row &&
        row.entity_id === entityId &&
        readSource(row.source) === kind &&
        (row.evidence ?? null) === basis
      )
        return false;
      const changed =
        !row || row.entity_id !== entityId || readSource(row.source) !== kind;
      this.db
        .prepare(
          `INSERT INTO ws_corpus_subject(thread_id, entity_id, evidence, source)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             entity_id = excluded.entity_id,
             evidence = excluded.evidence,
             source = excluded.source`,
        )
        .run(rootId, entityId, basis, kind);
      if (changed) this.bumpRevision();
      return changed;
    })();
  }

  /**
   * Gives a thread that has no topic of its own the topic of the thread it
   * was started from. Returns whether it changed anything.
   */
  inherit(threadId: string, fromThreadId: string): boolean {
    const source = this.assignment(fromThreadId);
    if (!source.entityId) return false;
    return this.inheritTopic(threadId, source.entityId);
  }

  /**
   * Gives a thread that has no topic of its own, or only Quick analysis's
   * guess, the topic `entityId` as inherited.
   */
  inheritTopic(threadId: string, entityId: string): boolean {
    if (!this.getById(entityId)) return false;
    const current = this.assignment(threadId);
    if (current.provenance !== null && current.provenance !== "quick")
      return false;
    this.assign(threadId, entityId, { provenance: "inherited" });
    return true;
  }

  /** The basis the thread's automatic topic was settled from, if any. */
  basis(threadId: string): string | null {
    const row = this.db
      .prepare("SELECT evidence FROM ws_corpus_subject WHERE thread_id = ?")
      .get(this.findRootThread(threadId)) as
      { evidence: string | null } | undefined;
    return row?.evidence ?? null;
  }

  /** Forgets a deleted thread's topic, so it no longer keeps a topic in use. */
  forget(threadId: string): void {
    this.db
      .prepare("DELETE FROM ws_corpus_subject WHERE thread_id = ?")
      .run(threadId);
  }

  /**
   * Removes discovered topics that no thread has, no workstream uses, and
   * that have no subtopics, deepest first. Topics you created are kept.
   */
  prune(): Topic[] {
    return this.db.transaction(() => {
      const removed: Topic[] = [];
      for (;;) {
        const row = this.db
          .prepare(
            `SELECT e.id FROM ws_corpus_entity e
             WHERE e.origin = 'discovered'
               AND NOT EXISTS (SELECT 1 FROM ws_corpus_subject s WHERE s.entity_id = e.id)
               AND NOT EXISTS (SELECT 1 FROM ws_corpus_group g WHERE g.entity_id = e.id)
               AND NOT EXISTS (SELECT 1 FROM ws_corpus_entity c WHERE c.parent_id = e.id)
             LIMIT 1`,
          )
          .get() as { id: string } | undefined;
        if (!row) break;
        removed.push(this.getById(row.id)!);
        this.db
          .prepare("DELETE FROM ws_corpus_entity WHERE id = ?")
          .run(row.id);
      }
      if (removed.length) this.bumpRevision();
      return removed;
    })();
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
  ): Topic {
    return this.db.transaction(() => {
      const entity = this.getById(entityId);
      if (!entity) throw new Error(`Unknown topic: ${entityId}`);

      let cleanName = entity.name;
      if (updates.name !== undefined) {
        cleanName = updates.name.trim();
        if (!cleanName) throw new Error("Entity name must not be empty");
        if (normalize(entity.name) !== normalize(cleanName)) {
          const conflict = this.resolve(cleanName, entity.parentId);
          if (conflict && conflict.id !== entityId) {
            throw new Error(
              `Topic name conflicts with an existing topic in this parent scope: ${cleanName}`,
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
          throw new Error("Topic alias must differ from its name");
        }
        if (
          cleanAliasList.some((alias) => {
            const other = this.resolve(alias, entity.parentId);
            return other && other.id !== entity.id;
          })
        ) {
          throw new Error(
            "Topic alias already resolves to an entity in this parent scope",
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
        .run(
          cleanName,
          nextDescription,
          JSON.stringify(nextAliases),
          entity.id,
        );

      this.bumpRevision();
      return {
        ...entity,
        name: cleanName,
        description: nextDescription,
        aliases: nextAliases,
      };
    })();
  }

  rename(entityId: string, newName: string): Topic {
    return this.edit(entityId, { name: newName });
  }

  reparent(entityId: string, newParentId: string | null): Topic {
    return this.db.transaction(() => {
      const entity = this.getById(entityId);
      if (!entity) throw new Error(`Unknown topic: ${entityId}`);
      if (entity.parentId === newParentId) return entity;
      if (newParentId === entityId)
        throw new Error("Cannot reparent an entity under itself");

      if (newParentId !== null) {
        const parent = this.getById(newParentId);
        if (!parent) throw new Error(`Unknown topic parent: ${newParentId}`);
        const parentAncestors = topicAncestors(newParentId, this.list());
        if (parentAncestors.includes(entityId)) {
          throw new Error(
            `Cannot reparent: entity ${entityId} is an ancestor of ${newParentId} (cycle detected)`,
          );
        }
      }

      const conflict = this.resolve(entity.name, newParentId);
      if (conflict && conflict.id !== entityId) {
        throw new Error(
          `Topic name conflicts with an existing topic in target parent scope: ${entity.name}`,
        );
      }

      for (const alias of entity.aliases) {
        const other = this.resolve(alias, newParentId);
        if (other && other.id !== entityId) {
          throw new Error(
            `Topic alias '${alias}' conflicts with an existing topic in target parent scope`,
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
  ): Topic {
    return this.edit(entityId, updates);
  }

  merge(
    sourceEntityId: string,
    targetEntityId: string,
  ): {
    target: Topic;
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
      const targetAncestors = topicAncestors(target.id, entities);
      const targetIsDescendantOfSource = targetAncestors.includes(source.id);

      const newTargetParentId = targetIsDescendantOfSource
        ? source.parentId
        : target.parentId;

      // Validate newTargetParentId
      if (newTargetParentId !== null) {
        const newParent = this.getById(newTargetParentId);
        if (!newParent)
          throw new Error(`Unknown topic parent: ${newTargetParentId}`);
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
            `Topic name conflicts with an existing topic in target parent scope: ${target.name}`,
          );
        }
        if (
          sibling.aliases.some((a) => normalize(a) === normalize(target.name))
        ) {
          throw new Error(
            `Topic name conflicts with an existing alias in target parent scope: ${target.name}`,
          );
        }
        for (const alias of combinedAliases) {
          if (
            normalize(sibling.name) === normalize(alias) ||
            sibling.aliases.some((a) => normalize(a) === normalize(alias))
          ) {
            throw new Error(
              `Topic alias '${alias}' conflicts with an existing topic in target parent scope`,
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

      const mergeSubtree = (src: Topic, dst: Topic) => {
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
                `Topic alias '${alias}' conflicts with an existing topic in target parent scope`,
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
                  `Topic name conflicts with an existing topic in target parent scope: ${child.name}`,
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
                    `Topic alias '${alias}' conflicts with an existing topic in target parent scope`,
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

  state(): TopicState {
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
        throw new Error(`Topic parent cycle detected at: ${currentId}`);
      visited.add(currentId);
      const current = this.getById(currentId);
      if (!current) throw new Error(`Unknown topic parent: ${currentId}`);
      currentId = current.parentId;
    }
  }
}
