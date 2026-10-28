import type { Entity } from "./classify.ts";
import { topicAncestors } from "./topics.ts";

export type RegroupInput = {
  entities: readonly Entity[];
  /** Visible roots assigned to each topic, completed ones included. */
  counts: Readonly<Record<string, number>>;
  /**
   * Products whose visible roots or more fall at or below it contract into
   * one workstream for the whole product.
   */
  collapseAt: number;
};

export const ancestors = topicAncestors;

/** The workstream topic a topic's roots file under: its nearest active self-or-ancestor. */
export function activeHome(
  id: string,
  active: readonly string[],
  entities: readonly { id: string; parentId: string | null }[],
) {
  return (
    topicAncestors(id, entities).find((parent) => active.includes(parent)) ??
    null
  );
}

/**
 * The topics that get a workstream. A product (a root topic) with visible
 * roots at or below `collapseAt` gets one workstream, its own; a larger one
 * gets a workstream for every topic that has a visible root, which the
 * sidebar nests by topic (see `nestGroups`). Deterministic and history-free:
 * the same counts always give the same workstreams.
 */
export function deriveActiveEntityIds(input: RegroupInput): string[] {
  const { entities, counts, collapseAt } = input;
  const byProduct = new Map<string, string[]>();
  for (const [id, count] of Object.entries(counts)) {
    if (!Number.isInteger(count) || count <= 0) continue;
    const product = ancestors(id, entities).at(-1)!;
    byProduct.set(product, [...(byProduct.get(product) ?? []), id]);
  }
  const selected: string[] = [];
  for (const root of entities.filter((entity) => entity.parentId === null)) {
    const topics = byProduct.get(root.id);
    if (!topics) continue;
    const total = topics.reduce((sum, id) => sum + counts[id]!, 0);
    if (total <= collapseAt) selected.push(root.id);
    else
      selected.push(
        ...entities
          .filter((entity) => topics.includes(entity.id))
          .map((entity) => entity.id),
      );
  }
  return selected;
}
