import type { Analysis, WorkState } from "./model.ts";

export type SidebarThread = {
  id: string;
  displayTitle: string;
  parentThreadId: string | null;
  sectionId: string | null;
  projectId: string;
  status: string;
  hasPendingInteraction: boolean;
  isUnread: boolean;
  isPinned: boolean;
  isHidden?: boolean;
  environmentPath?: string | null;
  updatedAt: number;
  latestAttentionAt: number;
};
export type SidebarRole = "manager" | "worker";
export type SidebarRow = {
  thread: SidebarThread;
  role: SidebarRole;
  managerId: string | null;
  managerTitle: string | null;
  viaWorkers: string[];
  state: WorkState | null;
  needsYou: boolean;
  immediateAsk: boolean;
  running: boolean;
  stale: boolean;
  recap: string | null;
  depth: number;
};
export type SidebarGroup = {
  id: string;
  name: string;
  manager: SidebarRow | null;
  unmanaged: boolean;
  rows: SidebarRow[];
  needsYou: number;
  summary: { about: string; status: string; needsYou?: number } | null;
};
export type HierarchyData = {
  roles: Record<string, SidebarRole>;
  managers: Record<string, string>;
};
export type SidebarModel = {
  recent: (SidebarRow & { group: string })[];
  needsYou: (SidebarRow & { group: string })[];
  groups: SidebarGroup[];
  other: (SidebarRow & { group: string })[];
  totalNeedsYou: number;
  warnings: string[];
};

const RUNNING = new Set(["starting", "active", "stopping"]);
const ORDER: (WorkState | null)[] = [
  "needs_decision",
  "ready_for_review",
  "blocked",
  "in_progress",
  null,
  "done",
];
const latest = (rows: SidebarRow[]) =>
  Math.max(0, ...rows.map((row) => row.thread.latestAttentionAt));
const rank = (row: SidebarRow) => (row.running ? -1 : ORDER.indexOf(row.state));
const urgency = (row: SidebarRow) =>
  row.thread.hasPendingInteraction ? 0 : row.thread.status === "active" ? 1 : 2;

/** Explicit manager titles identify product leads without relying on root-thread conventions. */
export function deriveSidebarHierarchy(threads: readonly SidebarThread[]): {
  roles: Map<string, SidebarRole>;
  managerFor: Map<string, SidebarThread>;
} {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const roles = new Map<string, SidebarRole>();
  for (const thread of threads)
    roles.set(
      thread.id,
      /\s*[—–-]\s*manager$/i.test(thread.displayTitle) ? "manager" : "worker",
    );
  const managerFor = new Map<string, SidebarThread>();
  for (const thread of threads) {
    let parentId = thread.parentThreadId;
    const seen = new Set([thread.id]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (roles.get(parent.id) === "manager") {
        managerFor.set(thread.id, parent);
        break;
      }
      parentId = parent.parentThreadId;
    }
  }
  return { roles, managerFor };
}

export const isImmediateAsk = (row: SidebarRow) => row.immediateAsk;
export const immediateAsk = isImmediateAsk;

function makeRow(
  thread: SidebarThread,
  role: SidebarRole,
  manager: SidebarThread | null,
  item: Analysis["items"][number] | undefined,
): SidebarRow {
  const stale = !item || item.updatedAt < thread.updatedAt;
  const inferredAsk = !stale && item?.state === "needs_decision";
  return {
    thread,
    role,
    managerId: manager?.id ?? null,
    managerTitle: manager?.displayTitle ?? null,
    viaWorkers: [],
    state: item?.state ?? null,
    needsYou: thread.hasPendingInteraction || !!inferredAsk,
    immediateAsk: thread.hasPendingInteraction || !!inferredAsk,
    running: RUNNING.has(thread.status),
    stale,
    recap: item?.recap ?? null,
    depth: 0,
  };
}

/** Renders a worker's inferred question on its reporting manager after the report arrives. */
export function routeQuestionOwners(
  rows: Map<string, SidebarRow>,
  workerToManager: ReadonlyMap<string, string>,
  viaWorkers: ReadonlyMap<string, string[]>,
): void {
  for (const [workerId, managerId] of workerToManager) {
    const worker = rows.get(workerId);
    const manager = rows.get(managerId);
    if (!worker || !manager || worker.thread.hasPendingInteraction) continue;
    const reportReceived = (viaWorkers.get(managerId) ?? []).includes(
      worker.thread.displayTitle,
    );
    if (!reportReceived || !worker.immediateAsk) continue;
    worker.needsYou = false;
    worker.immediateAsk = false;
    manager.needsYou = true;
    manager.immediateAsk = true;
    if (!manager.viaWorkers.includes(worker.thread.displayTitle))
      manager.viaWorkers.push(worker.thread.displayTitle);
  }
}

export function buildSidebar(
  threads: readonly SidebarThread[],
  analysis: Analysis | null,
  sectionNames: ReadonlyMap<string, string>,
  projectNames: ReadonlyMap<string, string>,
  viaWorkers: ReadonlyMap<string, string[]> = new Map(),
  hierarchy?: HierarchyData,
): SidebarModel {
  const derived = deriveSidebarHierarchy(threads);
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const roleMap = new Map(derived.roles);
  for (const [id, role] of Object.entries(hierarchy?.roles ?? {}))
    roleMap.set(id, role);
  const managerFor = new Map(derived.managerFor);
  for (const [worker, managerId] of Object.entries(hierarchy?.managers ?? {})) {
    const manager = byId.get(managerId);
    if (manager) managerFor.set(worker, manager);
  }
  const items = new Map(analysis?.items.map((item) => [item.threadId, item]));
  const rows = new Map<string, SidebarRow>();
  for (const thread of threads) {
    const role = roleMap.get(thread.id) ?? "worker";
    const manager =
      role === "manager" ? thread : (managerFor.get(thread.id) ?? null);
    rows.set(thread.id, makeRow(thread, role, manager, items.get(thread.id)));
  }
  routeQuestionOwners(
    rows,
    new Map([...managerFor].map(([worker, manager]) => [worker, manager.id])),
    viaWorkers,
  );

  // Match BB's custom sidebar: form parent/child trees first, then bucket each
  // entire tree by its root's native section. Descendants never split away from
  // a parent because their own sectionId differs.
  const children = new Map<string, SidebarThread[]>();
  const roots: SidebarThread[] = [];
  for (const thread of threads) {
    const parent = thread.parentThreadId
      ? byId.get(thread.parentThreadId)
      : null;
    if (parent)
      children.set(parent.id, [...(children.get(parent.id) ?? []), thread]);
    else roots.push(thread);
  }
  const warnings: string[] = [];
  const orphanIds = threads
    .filter(
      (thread) => thread.parentThreadId && !byId.has(thread.parentThreadId),
    )
    .map((thread) => thread.id);
  if (orphanIds.length)
    warnings.push(
      `${orphanIds.length} thread(s) had missing parents; shown as roots in their own groups.`,
    );
  const visited = new Set<string>();
  const groupBuckets = new Map<
    string,
    { name: string; rows: SidebarRow[]; roots: SidebarThread[] }
  >();
  const managerNames = new Map<string, number>();
  for (const thread of threads) {
    if (roleMap.get(thread.id) !== "manager") continue;
    const name = thread.displayTitle.replace(/\s*[—–-]\s*manager$/i, "");
    managerNames.set(name, (managerNames.get(name) ?? 0) + 1);
  }
  const groupForRoot = (root: SidebarThread) => {
    if (root.sectionId) {
      return {
        id: `section:${root.sectionId}`,
        name: sectionNames.get(root.sectionId) ?? "Section",
      };
    }
    if (roleMap.get(root.id) === "manager") {
      const base = root.displayTitle.replace(/\s*[—–-]\s*manager$/i, "");
      const name =
        (managerNames.get(base) ?? 0) > 1
          ? `${base} · ${root.id.slice(-6)}`
          : base;
      return { id: `manager:${root.id}`, name };
    }
    const item = items.get(root.id);
    const name =
      item?.group ?? projectNames.get(root.projectId) ?? "Unclassified";
    return { id: `product:${name.toLowerCase()}`, name };
  };
  const rootOrder = (a: SidebarThread, b: SidebarThread) =>
    rank(rows.get(a.id)!) - rank(rows.get(b.id)!) ||
    b.latestAttentionAt - a.latestAttentionAt ||
    a.id.localeCompare(b.id);
  roots.sort(rootOrder);
  const orderedRoots: SidebarThread[] = [];
  const collectTree = (root: SidebarThread) => {
    const collected: SidebarRow[] = [];
    const pending: { thread: SidebarThread; depth: number }[] = [
      { thread: root, depth: 0 },
    ];
    const localVisited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (localVisited.has(current.thread.id) || visited.has(current.thread.id))
        continue;
      localVisited.add(current.thread.id);
      visited.add(current.thread.id);
      const row = rows.get(current.thread.id);
      if (row) {
        row.depth = current.depth;
        collected.push(row);
      }
      const descendants = children.get(current.thread.id) ?? [];
      for (let i = descendants.length - 1; i >= 0; i--)
        pending.push({
          thread: descendants[i],
          depth: Math.min(2, current.depth + 1),
        });
    }
    if (collected.length) {
      orderedRoots.push(root);
      const group = groupForRoot(root);
      const bucket = groupBuckets.get(group.id) ?? {
        name: group.name,
        rows: [],
        roots: [],
      };
      bucket.rows.push(...collected);
      bucket.roots.push(root);
      groupBuckets.set(group.id, bucket);
    }
  };
  for (const root of roots) collectTree(root);
  // Cycles have no root. Break each remaining component at a stable id and
  // render it once, preserving the component as one subtree.
  const detached = threads
    .filter((thread) => !visited.has(thread.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (detached.length)
    warnings.push(
      `${detached.length} thread(s) were in a cyclic hierarchy; shown using a deterministic fallback.`,
    );
  for (const root of detached) if (!visited.has(root.id)) collectTree(root);

  const groups: SidebarGroup[] = [];
  for (const [id, bucket] of groupBuckets) {
    const managerRoots = bucket.roots.filter(
      (root) => roleMap.get(root.id) === "manager",
    );
    const manager =
      managerRoots.length === 1 ? (rows.get(managerRoots[0].id) ?? null) : null;
    const groupRows = manager
      ? bucket.rows.filter((row) => row.thread.id !== manager.thread.id)
      : bucket.rows;
    groups.push({
      id,
      name: bucket.name,
      manager,
      unmanaged: !managerRoots.length,
      rows: groupRows,
      needsYou: [...(manager ? [manager] : []), ...groupRows].filter(
        immediateAsk,
      ).length,
      summary: analysis?.summaries?.[bucket.name] ?? null,
    });
  }
  groups.sort(
    (a, b) =>
      Number(a.unmanaged) - Number(b.unmanaged) ||
      Number(a.name === "Unclassified") - Number(b.name === "Unclassified") ||
      b.needsYou - a.needsYou ||
      latest([...(a.manager ? [a.manager] : []), ...a.rows]) -
        latest([...(b.manager ? [b.manager] : []), ...b.rows]),
  );
  // Include all rows exactly once in live cross-group bands.
  const allRows = [...rows.values()].map((row) => {
    const root = orderedRoots.find((candidate) => {
      let current: SidebarThread | undefined = byId.get(row.thread.id);
      const seen = new Set<string>();
      while (current?.parentThreadId && !seen.has(current.id)) {
        seen.add(current.id);
        current = byId.get(current.parentThreadId);
      }
      return current?.id === candidate.id;
    });
    return { ...row, group: root ? groupForRoot(root).name : "Unclassified" };
  });
  const recent = allRows
    .filter((row) => row.thread.status !== "error")
    .sort(
      (a, b) =>
        b.thread.latestAttentionAt - a.thread.latestAttentionAt ||
        b.thread.updatedAt - a.thread.updatedAt,
    )
    .slice(0, 5);
  const needsYou = allRows
    .filter(immediateAsk)
    .sort(
      (a, b) =>
        urgency(a) - urgency(b) ||
        Number(b.thread.hasPendingInteraction) -
          Number(a.thread.hasPendingInteraction) ||
        b.thread.latestAttentionAt - a.thread.latestAttentionAt,
    );
  return {
    recent,
    needsYou,
    groups,
    other: [],
    totalNeedsYou: needsYou.length,
    warnings,
  };
}
