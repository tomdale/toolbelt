import type { Analysis, WorkState } from "./model.ts";
import { projectThreadTrees } from "./tree-groups.ts";

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

  const projection = projectThreadTrees(
    threads,
    roleMap,
    new Map([...items].map(([id, item]) => [id, item.group])),
    sectionNames,
    projectNames,
    (a, b) =>
      rank(rows.get(a.id)!) - rank(rows.get(b.id)!) ||
      b.latestAttentionAt - a.latestAttentionAt ||
      a.id.localeCompare(b.id),
  );
  const { warnings } = projection;
  const groups: SidebarGroup[] = [];
  for (const bucket of projection.groups) {
    const { id } = bucket;
    const bucketRows = bucket.rows.map(({ thread, depth }) => {
      const row = rows.get(thread.id)!;
      row.depth = depth;
      return row;
    });
    const managerRoots = bucket.roots.filter(
      (root) => roleMap.get(root.id) === "manager",
    );
    const manager =
      managerRoots.length === 1 ? (rows.get(managerRoots[0].id) ?? null) : null;
    const groupRows = manager
      ? bucketRows.filter((row) => row.thread.id !== manager.thread.id)
      : bucketRows;
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
  const allRows = [...rows.values()].map((row) => ({
    ...row,
    group: projection.groupByThread.get(row.thread.id)?.name ?? "Unclassified",
  }));
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
