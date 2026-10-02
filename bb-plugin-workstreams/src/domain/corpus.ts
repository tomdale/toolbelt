export type CorpusEntity = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly parentId: string | null;
  readonly aliases: readonly string[];
};

export type ActiveGroup = {
  readonly sectionId: string;
  readonly entityId: string;
};

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
