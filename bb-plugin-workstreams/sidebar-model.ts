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

/** Managers are explicit; product grouping is independent of the checkout's root thread. */
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
  for (const [worker, manager] of Object.entries(hierarchy?.managers ?? {})) {
    const managerThread = byId.get(manager);
    if (managerThread) managerFor.set(worker, managerThread);
  }
  const items = new Map(analysis?.items.map((item) => [item.threadId, item]));
  const managerThreads = threads.filter(
    (thread) => roleMap.get(thread.id) === "manager",
  );
  const groupByManager = new Map<string, string>();
  const labelByGroup = new Map<string, string>();
  const managerLabelCounts = new Map<string, number>();
  for (const manager of managerThreads) {
    const base = manager.displayTitle.replace(/\s*[—–-]\s*manager$/i, "");
    managerLabelCounts.set(base, (managerLabelCounts.get(base) ?? 0) + 1);
  }
  for (const manager of managerThreads) {
    const base = manager.displayTitle.replace(/\s*[—–-]\s*manager$/i, "");
    const id = `manager:${manager.id}`;
    groupByManager.set(manager.id, id);
    labelByGroup.set(
      id,
      (managerLabelCounts.get(base) ?? 0) > 1
        ? `${base} · ${manager.id.slice(-6)}`
        : base,
    );
  }

  const groupsById = new Map<string, SidebarRow[]>();
  const rows = new Map<string, SidebarRow>();
  for (const thread of threads) {
    const role = roleMap.get(thread.id) ?? "worker";
    const item = items.get(thread.id);
    const manager =
      role === "manager" ? thread : (managerFor.get(thread.id) ?? null);
    const groupId =
      role === "manager"
        ? groupByManager.get(thread.id)!
        : manager
          ? groupByManager.get(manager.id)!
          : `unmanaged:${item?.group ?? (thread.sectionId ? sectionNames.get(thread.sectionId) : undefined) ?? projectNames.get(thread.projectId) ?? "Unmanaged"}`;
    if (!labelByGroup.has(groupId))
      labelByGroup.set(groupId, groupId.slice("unmanaged:".length));
    const row = makeRow(thread, role, manager, item);
    rows.set(thread.id, row);
    if (role !== "manager") {
      const groupRows = groupsById.get(groupId) ?? [];
      groupRows.push(row);
      groupsById.set(groupId, groupRows);
    }
  }
  for (const manager of managerThreads) {
    const id = groupByManager.get(manager.id)!;
    if (!groupsById.has(id)) groupsById.set(id, []);
  }
  routeQuestionOwners(
    rows,
    new Map([...managerFor].map(([worker, manager]) => [worker, manager.id])),
    viaWorkers,
  );

  const groups: SidebarGroup[] = [];
  const warnings: string[] = [];
  for (const [id, members] of groupsById) {
    const name = labelByGroup.get(id)!;
    const managerThread = managerThreads.find(
      (thread) => groupByManager.get(thread.id) === id,
    );
    const manager = managerThread ? (rows.get(managerThread.id) ?? null) : null;
    const membersById = new Map(members.map((row) => [row.thread.id, row]));
    const children = new Map<string, SidebarRow[]>();
    const roots: SidebarRow[] = [];
    const malformed = new Set<string>();
    for (const row of members) {
      let ancestorId = row.thread.parentThreadId;
      const ancestry = new Set([row.thread.id]);
      while (ancestorId) {
        if (ancestry.has(ancestorId)) {
          malformed.add(row.thread.id);
          break;
        }
        ancestry.add(ancestorId);
        const ancestor = byId.get(ancestorId);
        if (!ancestor) {
          malformed.add(row.thread.id);
          break;
        }
        ancestorId = ancestor.parentThreadId;
      }
      let parentId = row.thread.parentThreadId;
      const seen = new Set([row.thread.id]);
      while (parentId && !membersById.has(parentId)) {
        if (seen.has(parentId)) {
          parentId = null;
          break;
        }
        seen.add(parentId);
        parentId = byId.get(parentId)?.parentThreadId ?? null;
      }
      if (!parentId && managerFor.has(row.thread.id)) {
        const managerId = managerFor.get(row.thread.id)!.id;
        if (membersById.has(managerId) && managerId !== row.thread.id)
          parentId = managerId;
      }
      if (parentId && membersById.has(parentId))
        children.set(parentId, [...(children.get(parentId) ?? []), row]);
      else roots.push(row);
      if (row.thread.parentThreadId && !byId.has(row.thread.parentThreadId))
        malformed.add(row.thread.id);
    }
    const ordered: SidebarRow[] = [];
    const visited = new Set<string>();
    const visit = (root: SidebarRow) => {
      const pending: { row: SidebarRow; depth: number }[] = [
        { row: root, depth: 0 },
      ];
      while (pending.length) {
        const current = pending.pop()!;
        if (visited.has(current.row.thread.id)) continue;
        visited.add(current.row.thread.id);
        ordered.push({ ...current.row, depth: current.depth });
        const descendants = children.get(current.row.thread.id) ?? [];
        for (let i = descendants.length - 1; i >= 0; i--)
          pending.push({
            row: descendants[i],
            depth: Math.min(2, current.depth + 1),
          });
      }
    };
    roots.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        b.thread.latestAttentionAt - a.thread.latestAttentionAt,
    );
    roots.forEach(visit);
    const detached = members
      .filter((row) => !visited.has(row.thread.id))
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          b.thread.latestAttentionAt - a.thread.latestAttentionAt ||
          a.thread.id.localeCompare(b.thread.id),
      );
    if (malformed.size || detached.length)
      warnings.push(
        `${new Set([...malformed, ...detached.map((row) => row.thread.id)]).size} thread(s) in “${name}” had missing parents or cyclic hierarchy; shown with a flat fallback where needed.`,
      );
    detached.forEach(visit);
    groups.push({
      id,
      name,
      manager,
      unmanaged: !id.startsWith("manager:"),
      rows: ordered,
      needsYou: [...(manager ? [manager] : []), ...ordered].filter(immediateAsk)
        .length,
      summary: analysis?.summaries?.[name] ?? null,
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
  const allRows = groups.flatMap((group) => [
    ...(group.manager ? [{ ...group.manager, group: group.name }] : []),
    ...group.rows.map((row) => ({ ...row, group: group.name })),
  ]);
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
