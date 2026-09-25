import type { Analysis, WorkState } from "./model.ts";

/** The subset of BB's live sidebar thread the Workstreams sidebar reads. */
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
  updatedAt: number;
};
export type SidebarRow = {
  thread: SidebarThread;
  state: WorkState | null;
  /** Waiting on the user: inferred work state, or the agent is blocked on an approval/question now. */
  needsYou: boolean;
  running: boolean;
  /** Analysis predates the thread's latest activity, or it was never analyzed. */
  stale: boolean;
  recap: string | null;
  depth: number;
};
export type SidebarGroup = {
  name: string;
  rows: SidebarRow[];
  needsYou: number;
  summary: { about: string; status: string } | null;
};
export type SidebarModel = {
  needsYou: (SidebarRow & { group: string })[];
  groups: SidebarGroup[];
  /** One-thread groups, folded together; each row keeps its group name. */
  other: (SidebarRow & { group: string })[];
  needsYouRemaining: number;
  allNeedsYou: (SidebarRow & { group: string })[];
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

/**
 * Arranges BB's live threads by Workstreams group. Unanalyzed threads fall
 * back to their section's name (Workstreams files sections by group), then
 * their project. Children nest under a parent in the same group.
 */
export function buildSidebar(
  threads: readonly SidebarThread[],
  analysis: Analysis | null,
  sectionNames: ReadonlyMap<string, string>,
  projectNames: ReadonlyMap<string, string>,
): SidebarModel {
  const items = new Map(analysis?.items.map((i) => [i.threadId, i]));
  const grouped = new Map<string, SidebarRow[]>();
  const groupOf = new Map<string, string>();
  for (const thread of threads) {
    const item = items.get(thread.id);
    const group =
      item?.group ??
      (thread.sectionId ? sectionNames.get(thread.sectionId) : undefined) ??
      projectNames.get(thread.projectId) ??
      "Other";
    groupOf.set(thread.id, group);
    const state = item?.state ?? null;
    const row: SidebarRow = {
      thread,
      state,
      needsYou: thread.hasPendingInteraction || !!item?.needsYou,
      running: RUNNING.has(thread.status),
      stale: !item || item.updatedAt < thread.updatedAt,
      recap: item?.recap ?? null,
      depth: 0,
    };
    grouped.set(group, [...(grouped.get(group) ?? []), row]);
  }
  const rank = (r: SidebarRow) =>
    r.running
      ? -1
      : ORDER.indexOf(r.needsYou && !r.state ? "needs_decision" : r.state);
  const groups: SidebarGroup[] = [];
  const other: SidebarModel["other"] = [];
  for (const [name, rows] of grouped) {
    rows.sort(
      (a, b) => rank(a) - rank(b) || b.thread.updatedAt - a.thread.updatedAt,
    );
    const ordered = nest(rows, groupOf);
    if (ordered.length === 1) {
      other.push({ ...ordered[0], group: name });
      continue;
    }
    groups.push({
      name,
      rows: ordered,
      needsYou: ordered.filter(waiting).length,
      summary: analysis?.summaries?.[name] ?? null,
    });
  }
  groups.sort(
    (a, b) =>
      Number(a.name === "Unclassified") - Number(b.name === "Unclassified") ||
      b.needsYou - a.needsYou ||
      latest(b.rows) - latest(a.rows),
  );
  other.sort(
    (a, b) => rank(a) - rank(b) || b.thread.updatedAt - a.thread.updatedAt,
  );
  // The band is for what only the user can unblock right now: a decision or a
  // pending approval/question. Work ready for review stays in its group.
  const needsYou = [
    ...groups.flatMap((g) => g.rows.map((r) => ({ ...r, group: g.name }))),
    ...other,
  ]
    .filter(waiting)
    .map((r) => ({ ...r, depth: 0 }))
    .sort(
      (a, b) =>
        urgency(a) - urgency(b) ||
        Number(b.thread.hasPendingInteraction) -
          Number(a.thread.hasPendingInteraction) ||
        b.thread.updatedAt - a.thread.updatedAt,
    );
  return {
    needsYou: needsYou.slice(0, 6),
    needsYouRemaining: Math.max(0, needsYou.length - 6),
    allNeedsYou: needsYou,
    groups,
    other,
  };
}

/** What only the user can unblock now; the Needs-you band and group badges. */
const waiting = (r: SidebarRow) =>
  r.thread.hasPendingInteraction || r.state === "needs_decision";
const urgency = (r: SidebarRow) =>
  r.thread.hasPendingInteraction ? 0 : r.thread.status === "active" ? 1 : 2;
const latest = (rows: SidebarRow[]) =>
  Math.max(...rows.map((r) => r.thread.updatedAt));

/** Places each child right after its parent when both are in the group. */
function nest(rows: SidebarRow[], groupOf: Map<string, string>): SidebarRow[] {
  const ids = new Set(rows.map((r) => r.thread.id));
  const children = new Map<string, SidebarRow[]>();
  const roots: SidebarRow[] = [];
  for (const row of rows) {
    const parent = row.thread.parentThreadId;
    if (
      parent &&
      ids.has(parent) &&
      groupOf.get(parent) === groupOf.get(row.thread.id)
    )
      children.set(parent, [...(children.get(parent) ?? []), row]);
    else roots.push(row);
  }
  const out: SidebarRow[] = [];
  const visit = (row: SidebarRow, depth: number) => {
    out.push({ ...row, depth });
    for (const child of children.get(row.thread.id) ?? [])
      visit(child, Math.min(depth + 1, 2));
  };
  roots.forEach((r) => visit(r, 0));
  return out;
}
