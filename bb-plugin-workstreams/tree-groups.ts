import { managerName } from "./manager";

export type TreeThread = {
  id: string;
  parentThreadId?: string | null;
  sectionId: string | null;
  projectId: string;
  displayTitle: string;
};

export type TreeGroup<T extends TreeThread> = {
  id: string;
  name: string;
  roots: T[];
  rows: { thread: T; depth: number }[];
};

/** Group complete parentage trees by the root's native section, manager, or product. */
export function projectThreadTrees<T extends TreeThread>(
  threads: readonly T[],
  roles: ReadonlyMap<string, "manager" | "worker">,
  products: ReadonlyMap<string, string>,
  sectionNames: ReadonlyMap<string, string>,
  projectNames: ReadonlyMap<string, string>,
  rootOrder?: (a: T, b: T) => number,
): {
  groups: TreeGroup<T>[];
  groupByThread: Map<string, TreeGroup<T>>;
  warnings: string[];
} {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const thread of threads) {
    const parent = thread.parentThreadId
      ? byId.get(thread.parentThreadId)
      : null;
    if (parent)
      children.set(parent.id, [...(children.get(parent.id) ?? []), thread]);
    else roots.push(thread);
  }
  const warnings: string[] = [];
  const orphans = threads.filter(
    (thread) => thread.parentThreadId && !byId.has(thread.parentThreadId),
  );
  if (orphans.length)
    warnings.push(
      `${orphans.length} thread(s) had missing parents; shown as roots in their own groups.`,
    );
  const managerNames = new Map<string, number>();
  for (const thread of threads) {
    if (roles.get(thread.id) !== "manager") continue;
    const name = managerName(thread.displayTitle);
    if (name) managerNames.set(name, (managerNames.get(name) ?? 0) + 1);
  }
  const groupForRoot = (root: T) => {
    if (root.sectionId)
      return {
        id: `section:${root.sectionId}`,
        name: sectionNames.get(root.sectionId) ?? "Section",
      };
    if (roles.get(root.id) === "manager") {
      const base = managerName(root.displayTitle) ?? root.displayTitle;
      return {
        id: `manager:${root.id}`,
        name:
          (managerNames.get(base) ?? 0) > 1
            ? `${base} · ${root.id.slice(-6)}`
            : base,
      };
    }
    const name =
      products.get(root.id) ??
      projectNames.get(root.projectId) ??
      "Unclassified";
    return { id: `product:${name.toLowerCase()}`, name };
  };
  if (rootOrder) roots.sort(rootOrder);
  const buckets = new Map<string, TreeGroup<T>>();
  const groupByThread = new Map<string, TreeGroup<T>>();
  const visited = new Set<string>();
  const collectTree = (root: T) => {
    const collected: TreeGroup<T>["rows"] = [];
    const pending = [{ thread: root, depth: 0 }];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current.thread.id)) continue;
      visited.add(current.thread.id);
      collected.push(current);
      const descendants = children.get(current.thread.id) ?? [];
      for (let i = descendants.length - 1; i >= 0; i--)
        pending.push({
          thread: descendants[i],
          depth: Math.min(2, current.depth + 1),
        });
    }
    if (!collected.length) return;
    const key = groupForRoot(root);
    const bucket = buckets.get(key.id) ?? {
      ...key,
      roots: [],
      rows: [],
    };
    bucket.roots.push(root);
    bucket.rows.push(...collected);
    for (const { thread } of collected) groupByThread.set(thread.id, bucket);
    buckets.set(key.id, bucket);
  };
  for (const root of roots) collectTree(root);
  // Parent cycles have no root. Break each remaining component at a stable id.
  const detached = threads
    .filter((thread) => !visited.has(thread.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (detached.length)
    warnings.push(
      `${detached.length} thread(s) were in a cyclic hierarchy; shown using a deterministic fallback.`,
    );
  for (const root of detached) if (!visited.has(root.id)) collectTree(root);
  return { groups: [...buckets.values()], groupByThread, warnings };
}
