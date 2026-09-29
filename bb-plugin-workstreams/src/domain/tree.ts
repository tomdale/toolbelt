/**
 * Parent/child forests over BB threads.
 *
 * BB stores hierarchy as flat `parentThreadId` links, which can point at a
 * thread the caller cannot see (archived, hidden, deleted) or, in corrupt data,
 * form a cycle. The forest built here places every input thread exactly once:
 * a thread whose parent is absent becomes a root, and each cycle is broken at
 * its lowest id so the result is deterministic.
 */

export type TreeThread = {
  readonly id: string;
  readonly parentThreadId?: string | null;
};

export type TreeNode<T extends TreeThread> = {
  readonly thread: T;
  readonly depth: number;
  readonly children: TreeNode<T>[];
};

export type Forest<T extends TreeThread> = {
  readonly roots: TreeNode<T>[];
  /** Root thread of each input thread's tree, keyed by thread id. */
  readonly rootOf: ReadonlyMap<string, T>;
  /** Threads whose parent is not in the input; they render as roots. */
  readonly orphanIds: readonly string[];
  /** Threads that were only reachable through a parent cycle. */
  readonly cycleIds: readonly string[];
};

export type ForestOrder<T> = {
  roots?: (a: T, b: T) => number;
  children?: (a: T, b: T) => number;
};

const byId = <T extends TreeThread>(a: T, b: T) => a.id.localeCompare(b.id);

export function buildForest<T extends TreeThread>(
  threads: readonly T[],
  order: ForestOrder<T> = {},
): Forest<T> {
  const present = new Map(threads.map((thread) => [thread.id, thread]));
  const childrenOf = new Map<string, T[]>();
  const rootCandidates: T[] = [];
  const orphanIds: string[] = [];
  for (const thread of present.values()) {
    const parentId = thread.parentThreadId ?? null;
    if (parentId && parentId !== thread.id && present.has(parentId)) {
      const siblings = childrenOf.get(parentId) ?? [];
      siblings.push(thread);
      childrenOf.set(parentId, siblings);
    } else {
      if (parentId) orphanIds.push(thread.id);
      rootCandidates.push(thread);
    }
  }
  const childOrder = order.children ?? byId;
  for (const siblings of childrenOf.values()) siblings.sort(childOrder);

  const visited = new Set<string>();
  const rootOf = new Map<string, T>();
  const grow = (thread: T, depth: number, root: T): TreeNode<T> => {
    visited.add(thread.id);
    rootOf.set(thread.id, root);
    const children: TreeNode<T>[] = [];
    for (const child of childrenOf.get(thread.id) ?? [])
      if (!visited.has(child.id)) children.push(grow(child, depth + 1, root));
    return { thread, depth, children };
  };

  const roots = rootCandidates.map((root) => grow(root, 0, root));
  // Anything unvisited is only reachable through a cycle. Break each cycle at
  // its lowest id so repeated renders agree.
  const cycleIds: string[] = [];
  for (const thread of [...present.values()].sort(byId)) {
    if (visited.has(thread.id)) continue;
    const root = grow(thread, 0, thread);
    roots.push(root);
    for (const node of flatten(root)) cycleIds.push(node.thread.id);
  }
  if (order.roots) roots.sort((a, b) => order.roots!(a.thread, b.thread));
  return { roots, rootOf, orphanIds, cycleIds };
}

/** Depth-first rows for rendering; parents precede their children. */
export function flatten<T extends TreeThread>(
  node: TreeNode<T>,
  into: TreeNode<T>[] = [],
): TreeNode<T>[] {
  into.push(node);
  for (const child of node.children) flatten(child, into);
  return into;
}
