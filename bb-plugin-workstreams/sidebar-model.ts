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
export type SidebarRole = "dispatch" | "manager" | "worker";
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
  dispatchIds: string[];
  roles: Record<string, SidebarRole>;
  managers: Record<string, string>;
};
export type SidebarModel = {
  dispatch: SidebarRow[];
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
const normalizePath = (path: string | null | undefined) =>
  (path ?? "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();

/** A parentless thread at the tomdaleOS checkout is Dispatch; its child is a manager. */
export function deriveSidebarHierarchy(
  threads: readonly SidebarThread[],
  tomdaleOSPath = "/Users/tomdale/Code/tomdaleOS",
): {
  dispatch: SidebarThread[];
  roles: Map<string, SidebarRole>;
  managerFor: Map<string, SidebarThread>;
} {
  const dispatch = threads.filter(
    (thread) =>
      !thread.parentThreadId &&
      normalizePath(thread.environmentPath) === normalizePath(tomdaleOSPath),
  );
  const dispatchIds = new Set(dispatch.map((thread) => thread.id));
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const roles = new Map<string, SidebarRole>();
  for (const thread of threads) {
    const parent = thread.parentThreadId
      ? byId.get(thread.parentThreadId)
      : undefined;
    roles.set(
      thread.id,
      dispatchIds.has(thread.id)
        ? "dispatch"
        : parent && dispatchIds.has(parent.id)
          ? "manager"
          : "worker",
    );
  }
  const managerFor = new Map<string, SidebarThread>();
  for (const thread of threads) {
    let current = thread;
    const seen = new Set<string>();
    while (current.parentThreadId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.parentThreadId);
      if (!parent) break;
      if (roles.get(parent.id) === "manager") {
        managerFor.set(thread.id, parent);
        break;
      }
      current = parent;
    }
  }
  return { dispatch, roles, managerFor };
}

export const isImmediateAsk = (row: SidebarRow) => row.immediateAsk;
export const immediateAsk = isImmediateAsk;
const rank = (row: SidebarRow) => (row.running ? -1 : ORDER.indexOf(row.state));
const urgency = (row: SidebarRow) =>
  row.thread.hasPendingInteraction ? 0 : row.thread.status === "active" ? 1 : 2;
const latest = (rows: SidebarRow[]) =>
  Math.max(0, ...rows.map((row) => row.thread.latestAttentionAt));

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

/** Renders a worker's inferred question on its manager after the report arrives. */
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
  dispatchSectionIds: ReadonlySet<string> = new Set(),
): SidebarModel {
  const derived = deriveSidebarHierarchy(threads);
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const sectionDispatch = threads.filter(
    (thread) =>
      !thread.parentThreadId && dispatchSectionIds.has(thread.sectionId ?? ""),
  );
  const dispatchById = new Map(
    [
      ...derived.dispatch,
      ...sectionDispatch,
      ...(hierarchy?.dispatchIds ?? [])
        .map((id) => byId.get(id))
        .filter((t): t is SidebarThread => !!t),
    ].map((thread) => [thread.id, thread]),
  );
  const dispatchThreads = [...dispatchById.values()];
  const dispatchIds = new Set(dispatchById.keys());
  const roleMap = new Map(derived.roles);
  for (const [id, role] of Object.entries(hierarchy?.roles ?? {}))
    roleMap.set(id, role);
  for (const thread of dispatchThreads) roleMap.set(thread.id, "dispatch");
  const managerFor = new Map(derived.managerFor);
  for (const [worker, manager] of Object.entries(hierarchy?.managers ?? {})) {
    const managerThread = byId.get(manager);
    if (managerThread) managerFor.set(worker, managerThread);
  }
  const items = new Map(analysis?.items.map((item) => [item.threadId, item]));
  const dispatchRoots = dispatchThreads
    .map((thread) => makeRow(thread, "dispatch", null, items.get(thread.id)))
    .sort((a, b) => b.thread.latestAttentionAt - a.thread.latestAttentionAt);
  const dispatchChildren = new Map<string, SidebarThread[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId || dispatchIds.has(thread.id)) continue;
    dispatchChildren.set(thread.parentThreadId, [
      ...(dispatchChildren.get(thread.parentThreadId) ?? []),
      thread,
    ]);
  }
  const dispatchFamilyIds = new Set(dispatchIds);
  const pendingFamily = [...dispatchIds];
  while (pendingFamily.length > 0) {
    const parentId = pendingFamily.pop()!;
    for (const child of dispatchChildren.get(parentId) ?? []) {
      if (dispatchFamilyIds.has(child.id)) continue;
      dispatchFamilyIds.add(child.id);
      pendingFamily.push(child.id);
    }
  }

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
    if (dispatchIds.has(thread.id) || role === "dispatch") continue;
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
    if (dispatchIds.has(manager.parentThreadId ?? "")) continue;
    const groupId = groupByManager.get(manager.id)!;
    if (!groupsById.has(groupId)) groupsById.set(groupId, []);
  }
  routeQuestionOwners(
    rows,
    new Map([...managerFor].map(([worker, manager]) => [worker, manager.id])),
    viaWorkers,
  );

  const dispatch: SidebarRow[] = [...dispatchRoots];
  const dispatchWarnings = new Set<string>();
  const renderedDispatchIds = new Set(dispatch.map((row) => row.thread.id));
  for (const root of dispatchRoots) {
    for (const thread of dispatchChildren.get(root.thread.id) ?? []) {
      if (renderedDispatchIds.has(thread.id)) {
        dispatchWarnings.add(thread.id);
        continue;
      }
      renderedDispatchIds.add(thread.id);
      const role = roleMap.get(thread.id) ?? "worker";
      const row =
        rows.get(thread.id) ??
        makeRow(thread, role, null, items.get(thread.id));
      rows.set(thread.id, row);
      dispatch.push({ ...row, depth: 1 });
    }
  }

  const groups: SidebarGroup[] = [];
  const warnings: string[] = [];
  if (dispatchWarnings.size > 0)
    warnings.push(
      `Cyclic Dispatch hierarchy detected (${[...dispatchWarnings].join(", ")}); duplicate links were omitted.`,
    );
  for (const [id, members] of groupsById) {
    const name = labelByGroup.get(id)!;
    const managerThread = managerThreads.find(
      (thread) => groupByManager.get(thread.id) === id,
    );
    const managerRow = managerThread
      ? (rows.get(managerThread.id) ?? null)
      : null;
    const manager =
      managerRow && !dispatchIds.has(managerRow.thread.parentThreadId ?? "")
        ? managerRow
        : null;
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
      if (parentId && membersById.has(parentId)) {
        children.set(parentId, [...(children.get(parentId) ?? []), row]);
      } else roots.push(row);
      if (row.thread.parentThreadId && !byId.has(row.thread.parentThreadId))
        malformed.add(row.thread.id);
    }
    const ordered: SidebarRow[] = [];
    const visited = new Set<string>();
    const visit = (root: SidebarRow) => {
      const pending: { row: SidebarRow; depth: number }[] = [
        { row: root, depth: 0 },
      ];
      while (pending.length > 0) {
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
        Number(b.role === "manager") - Number(a.role === "manager") ||
        rank(a) - rank(b) ||
        b.thread.latestAttentionAt - a.thread.latestAttentionAt,
    );
    roots.forEach(visit);
    // Broken parent links and cycles have no root; render each remaining row
    // once as a root rather than silently losing that component.
    const detached = members
      .filter((row) => !visited.has(row.thread.id))
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          b.thread.latestAttentionAt - a.thread.latestAttentionAt ||
          a.thread.id.localeCompare(b.thread.id),
      );
    if (malformed.size > 0 || detached.length > 0)
      warnings.push(
        `${new Set([...malformed, ...detached.map((row) => row.thread.id)]).size} thread(s) in “${name}” had missing parents or cyclic hierarchy; shown with a flat fallback where needed.`,
      );
    detached.forEach(visit);
    const workerRows = ordered.filter((row) => row.role !== "manager");
    groups.push({
      id,
      name,
      manager,
      unmanaged: !id.startsWith("manager:"),
      rows: workerRows,
      needsYou: [...(manager ? [manager] : []), ...workerRows].filter(
        immediateAsk,
      ).length,
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
  const allRows = [
    ...dispatch.map((row) => ({ ...row, group: "Dispatch" })),
    ...groups.flatMap((group) => [
      ...(group.manager ? [{ ...group.manager, group: group.name }] : []),
      ...group.rows.map((row) => ({ ...row, group: group.name })),
    ]),
  ];
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
    dispatch,
    recent,
    needsYou,
    groups,
    other: [],
    totalNeedsYou: needsYou.length,
    warnings,
  };
}
