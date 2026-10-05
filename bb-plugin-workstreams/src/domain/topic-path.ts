import type { Topic } from "./topics.ts";

/** Full ancestry distinguishes same-named features in different component scopes. */
export function topicPath(
  id: string,
  entities: readonly Topic[],
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current) {
    if (seen.has(current)) throw new Error("Topic tree contains a cycle.");
    seen.add(current);
    const entity = entities.find((e) => e.id === current);
    if (!entity) throw new Error("Unknown topic.");
    parts.unshift(entity.name);
    current = entity.parentId;
  }
  return parts.join(": ");
}
