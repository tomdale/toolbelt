export type CorpusEntity = {
  id: string;
  name: string;
  description: string;
  parentId: string | null;
  aliases: string[];
};

export type AssignmentProvenance = "manual" | "automatic";
export type AssignmentStatus = "assigned" | "unresolved";

export type CanonicalAssignment = {
  threadId: string;
  entityId: string | null;
  status: AssignmentStatus;
  provenance: AssignmentProvenance | null;
  label: string | null;
  ancestorIds: string[];
  evidence: string | null;
  inheritedFrom: string | null;
};

export type CatalogGroupBinding = {
  sectionId: string;
  entityId: string;
};

export type CatalogState = {
  entities: CorpusEntity[];
  groups: Record<string, string>;
  assignments: Record<string, CanonicalAssignment>;
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
export function entityAncestors(
  id: string,
  entities: readonly CorpusEntity[],
): string[] {
  const result: string[] = [];
  let current: string | null = id;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) throw new Error("Corpus contains a cycle.");
    seen.add(current);
    result.push(current);
    const entity = entities.find((e) => e.id === current);
    if (!entity) throw new Error(`Unknown corpus identity: ${current}`);
    current = entity.parentId;
  }
  return result;
}

/** Returns the nearest ancestor of a subject entity that has an active group. */
export function nearestActive(
  subjectId: string,
  entities: readonly CorpusEntity[],
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
  let current: CorpusEntity | undefined = byId.get(subjectId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const sectionId = activeSections.get(current.id)?.[0];
    if (sectionId) return sectionId;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return null;
}
