export type Topic = {
  id: string;
  name: string;
  description: string;
  parentId: string | null;
  aliases: string[];
};

/**
 * Where a thread's topic came from, in priority order: a topic you set, one
 * inherited from the thread or workstream the thread was started from, one
 * Full analysis settled at a turn's end, and Quick analysis's guess from the
 * first request. A later source never replaces an earlier one, except that
 * Full analysis replaces an inherited topic when the scope shifts.
 */
export type AssignmentProvenance = "manual" | "inherited" | "full" | "quick";

/** Whether Workstreams chose the topic, so it may change it again. */
export const isAutomatic = (provenance: AssignmentProvenance | null) =>
  provenance !== null && provenance !== "manual";
export type AssignmentStatus = "assigned" | "unresolved";

export type TopicAssignment = {
  threadId: string;
  entityId: string | null;
  status: AssignmentStatus;
  provenance: AssignmentProvenance | null;
  label: string | null;
  ancestorIds: string[];
  evidence: string | null;
  inheritedFrom: string | null;
};

export type TopicGroupBinding = {
  sectionId: string;
  entityId: string;
};

export type TopicState = {
  entities: Topic[];
  groups: Record<string, string>;
  assignments: Record<string, TopicAssignment>;
  revision: number;
};

export type DraftAncestor = {
  name: string;
  description: string;
};

export type DraftSubjectProposal = {
  name: string;
  description: string;
  parentId?: string | null;
  ancestors?: DraftAncestor[] | null;
};

export type ActiveGroup = {
  readonly sectionId: string;
  readonly entityId: string;
};

/** Returns ancestor entity IDs from nearest up to root. */
export function topicAncestors(
  id: string,
  entities: readonly { id: string; parentId: string | null }[],
): string[] {
  const result: string[] = [];
  let current: string | null = id;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) throw new Error("Topic tree contains a cycle.");
    seen.add(current);
    result.push(current);
    const entity = entities.find((e) => e.id === current);
    if (!entity) throw new Error(`Unknown topic: ${current}`);
    current = entity.parentId;
  }
  return result;
}

/** A proposal resolved against the topic tree: an existing topic, or a discovery. */
export type ResolvedProposal =
  | { subjectId: string; proposed: null }
  | { subjectId: null; proposed: DraftSubjectProposal };

const sameName = (
  entity: { name: string; aliases: readonly string[] },
  name: string,
) => {
  const target = name.trim().toLowerCase();
  return [entity.name, ...entity.aliases].some(
    (candidate) => candidate.trim().toLowerCase() === target,
  );
};

/**
 * Anchors a proposal at its deepest existing ancestor, so `parentId` names that
 * topic and `ancestors` lists only missing parents. Classifiers sometimes
 * restate existing ancestry in `ancestors` (parent "Subagents" with ancestors
 * ["Subagents"]); taken verbatim, that creates a same-named copy of the parent.
 *
 * Each segment, outermost first and the leaf last, that names an topic on
 * the anchor's own path or an existing child of the anchor (an existing root
 * without one) becomes the anchor; the first other segment starts the missing
 * remainder. Names match by name or alias, ignoring case, as the topic tree's
 * sibling lookup does. When the leaf resolves too, the proposal is that
 * existing topic.
 */
export function resolveProposal(
  proposal: DraftSubjectProposal,
  entities: readonly {
    id: string;
    name: string;
    parentId: string | null;
    aliases: readonly string[];
  }[],
): ResolvedProposal {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const segments = [...(proposal.ancestors ?? []), proposal];
  let anchor = proposal.parentId ?? null;
  let resolved = 0;
  for (const segment of segments) {
    const restated = anchor
      ? topicAncestors(anchor, entities).find((id) =>
          sameName(byId.get(id)!, segment.name),
        )
      : undefined;
    const next =
      restated ??
      entities.find(
        (entity) =>
          entity.parentId === anchor && sameName(entity, segment.name),
      )?.id;
    if (!next) break;
    anchor = next;
    resolved++;
  }
  if (resolved === segments.length && anchor)
    return { subjectId: anchor, proposed: null };
  if (resolved === 0) return { subjectId: null, proposed: proposal };
  return {
    subjectId: null,
    proposed: {
      ...proposal,
      parentId: anchor,
      ancestors: (proposal.ancestors ?? []).slice(resolved),
    },
  };
}

/** Returns the nearest ancestor of a subject entity that has an active group. */
export function nearestActive(
  subjectId: string,
  entities: readonly Topic[],
  groups: ReadonlyMap<string, string>,
): string | null {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const activeSections = new Map<string, string[]>();
  for (const [sectionId, entityId] of groups) {
    const sections = activeSections.get(entityId) ?? [];
    sections.push(sectionId);
    activeSections.set(entityId, sections);
  }
  for (const sections of activeSections.values())
    sections.sort((a, b) => a.localeCompare(b));

  const visited = new Set<string>();
  let current: Topic | undefined = byId.get(subjectId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const sectionId = activeSections.get(current.id)?.[0];
    if (sectionId) return sectionId;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return null;
}
