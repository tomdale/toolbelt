import type { CorpusEntity } from "./corpus.ts";

/** Full ancestry distinguishes same-named features in different component scopes. */
export function corpusLabel(
  id: string,
  entities: readonly CorpusEntity[],
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current) {
    if (seen.has(current)) throw new Error("Corpus relationship cycle.");
    seen.add(current);
    const entity = entities.find((e) => e.id === current);
    if (!entity) throw new Error("Unknown corpus identity.");
    parts.unshift(entity.name);
    current = entity.parentId;
  }
  return parts.join(": ");
}
