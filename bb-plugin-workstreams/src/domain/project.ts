/**
 * The one projection behind the sidebar and the Workstreams page (SPEC I8).
 *
 * A workstream is a native BB section. Threads are grouped the way BB's own
 * sidebar groups them: build the complete parent/child forest first, then file
 * each tree under its root's section (SPEC I2). Every visible, non-archived
 * thread appears in exactly one group row (SPEC I1), or in Snoozed: a snoozed
 * thread leaves its group, with its descendants, until it wakes. Up Next and
 * Recent are overlays that reference the group rows; they never replace them,
 * and never show snoozed threads. Prioritized workstreams lead the groups and
 * never go dormant.
 */
import { applyOrder, type ManualOrder } from "./order.ts";
import {
  buildForest,
  flatten,
  type TreeNode,
  type TreeThread,
} from "./tree.ts";

export type WorkstreamThread = TreeThread & {
  readonly sectionId: string | null;
  readonly isHidden: boolean;
  readonly isArchived: boolean;
  readonly isPinned: boolean;
  readonly pinSortKey?: string | null;
  readonly hasPendingInteraction: boolean;
  readonly latestAttentionAt: number;
  readonly createdAt: number;
};

export type Section = { readonly id: string; readonly name: string };

export type Row<T extends WorkstreamThread> = {
  readonly thread: T;
  readonly depth: number;
  readonly hasChildren: boolean;
  /** The workstream (section id) the row's tree belongs to; null = Unsorted. */
  readonly workstreamId: string | null;
  readonly needsYou: boolean;
};

export type Group<T extends WorkstreamThread> = {
  /** Section id, or {@link UNSORTED_ID}. */
  readonly id: string;
  readonly name: string;
  readonly rows: readonly Row<T>[];
  readonly total: number;
  readonly needsYou: number;
  /** Latest attention time across the group's threads; 0 when empty. */
  readonly lastActiveAt: number;
  /** The user prioritized this workstream (never Unsorted). */
  readonly prioritized: boolean;
};

export type Projection<T extends WorkstreamThread> = {
  readonly needsYou: readonly Row<T>[];
  readonly recent: readonly Row<T>[];
  /**
   * Active workstreams: prioritized ones first, each tier in the manual
   * order, else BB's section order.
   */
  readonly groups: readonly Group<T>[];
  readonly unsorted: Group<T>;
  /** Workstreams with no visible threads, or none active within the window. */
  readonly dormant: readonly Group<T>[];
  /**
   * Snoozed subtrees, soonest to wake first (activity snoozes last). Depths
   * start at 0 for each snoozed thread; `workstreamId` is still the group the
   * thread returns to.
   */
  readonly snoozed: readonly Row<T>[];
  /** Every row, snoozed ones included. */
  readonly rowOf: ReadonlyMap<string, Row<T>>;
  /**
   * Children whose question folded into their parent's newer one, keyed by
   * parent id. Folded children stay in their group but leave the Up Next
   * band and counts, so one decision isn't counted twice.
   */
  readonly needsYouVia: ReadonlyMap<string, readonly T[]>;
};

export const UNSORTED_ID = "unsorted";
export const DAY_MS = 24 * 60 * 60 * 1000;

export type ProjectionOptions<T extends WorkstreamThread> = {
  readonly now: number;
  readonly recentLimit?: number;
  readonly dormantAfterMs?: number;
  /** Whether a thread needs Tom. Defaults to a live pending interaction. */
  readonly needsYou?: (thread: T) => boolean;
  /**
   * The user's drag-and-drop order for workstreams and root threads, and the
   * prioritized workstreams.
   */
  readonly order?: ManualOrder;
  /**
   * A snoozed thread's wake time (null: until its next activity); undefined
   * when the thread isn't snoozed.
   */
  readonly snoozedUntil?: (thread: T) => number | null | undefined;
};

const pinOrder = (a: WorkstreamThread, b: WorkstreamThread) =>
  (a.pinSortKey ?? "").localeCompare(b.pinSortKey ?? "");

/** Pinned roots first in manual order, then most recent attention first. */
export function compareRoots(a: WorkstreamThread, b: WorkstreamThread): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  if (a.isPinned) return pinOrder(a, b) || a.id.localeCompare(b.id);
  return b.latestAttentionAt - a.latestAttentionAt || a.id.localeCompare(b.id);
}

/** Children keep creation order so a delegation reads top to bottom. */
export function compareChildren(
  a: WorkstreamThread,
  b: WorkstreamThread,
): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

export function projectWorkstreams<T extends WorkstreamThread>(
  threads: readonly T[],
  sections: readonly Section[],
  options: ProjectionOptions<T>,
): Projection<T> {
  const recentLimit = options.recentLimit ?? 5;
  const dormantAfterMs = options.dormantAfterMs ?? 30 * DAY_MS;
  const needsYou =
    options.needsYou ?? ((thread: T) => thread.hasPendingInteraction);
  const visible = threads.filter(
    (thread) => !thread.isHidden && !thread.isArchived,
  );
  const forest = buildForest(visible, {
    roots: compareRoots,
    children: compareChildren,
  });
  const known = new Set(sections.map((section) => section.id));
  const groupKeyOf = (root: T) =>
    root.sectionId && known.has(root.sectionId) ? root.sectionId : UNSORTED_ID;

  // Snoozed threads leave their trees with their whole subtree; what's left
  // of each tree stays in its group.
  const wakeOf = options.snoozedUntil ?? (() => undefined);
  const snoozedNodes: TreeNode<T>[] = [];
  const prune = (node: TreeNode<T>): TreeNode<T> => ({
    ...node,
    children: node.children
      .filter((child) => {
        if (wakeOf(child.thread) === undefined) return true;
        snoozedNodes.push(child);
        return false;
      })
      .map(prune),
  });
  const activeRoots: TreeNode<T>[] = [];
  for (const root of forest.roots)
    if (wakeOf(root.thread) === undefined) activeRoots.push(prune(root));
    else snoozedNodes.push(root);

  const rootsBySection = new Map<string, TreeNode<T>[]>();
  for (const root of activeRoots) {
    const key = groupKeyOf(root.thread);
    const roots = rootsBySection.get(key) ?? [];
    roots.push(root);
    rootsBySection.set(key, roots);
  }
  const rowsBySection = new Map<string, Row<T>[]>();
  const rowOf = new Map<string, Row<T>>();
  for (const [key, roots] of rootsBySection) {
    const workstreamId = key === UNSORTED_ID ? null : key;
    const rows: Row<T>[] = [];
    const ordered = applyOrder(
      roots,
      options.order?.threads[key],
      (root) => root.thread.id,
      "first",
    );
    for (const node of ordered.flatMap((root) => flatten(root))) {
      const row: Row<T> = {
        thread: node.thread,
        depth: node.depth,
        hasChildren: node.children.length > 0,
        workstreamId,
        needsYou: needsYou(node.thread),
      };
      rows.push(row);
      rowOf.set(node.thread.id, row);
    }
    rowsBySection.set(key, rows);
  }

  // A child's question folds into its parent when the parent has a newer
  // turn that also needs a decision (SPEC §10: timestamps only). A pending
  // interaction never folds: only the child can answer it.
  const needsYouVia = new Map<string, T[]>();
  const folded = new Set<string>();
  for (const row of rowOf.values()) {
    if (!row.needsYou || !row.thread.parentThreadId) continue;
    if (row.thread.hasPendingInteraction) continue;
    const parent = rowOf.get(row.thread.parentThreadId);
    if (
      !parent?.needsYou ||
      parent.thread.latestAttentionAt <= row.thread.latestAttentionAt
    )
      continue;
    folded.add(row.thread.id);
    needsYouVia.set(parent.thread.id, [
      ...(needsYouVia.get(parent.thread.id) ?? []),
      row.thread,
    ]);
  }
  const counts = (row: Row<T>) => row.needsYou && !folded.has(row.thread.id);

  const prioritized = new Set(options.order?.prioritized ?? []);
  const group = (id: string, name: string): Group<T> => {
    const rows = rowsBySection.get(id) ?? [];
    return {
      id,
      name,
      rows,
      total: rows.length,
      needsYou: rows.filter(counts).length,
      lastActiveAt: Math.max(
        0,
        ...rows.map((row) => row.thread.latestAttentionAt),
      ),
      prioritized: id !== UNSORTED_ID && prioritized.has(id),
    };
  };

  const pinned: Group<T>[] = [];
  const groups: Group<T>[] = [];
  const empty: Group<T>[] = [];
  const dormant: Group<T>[] = [];
  const orderedSections = applyOrder(
    sections,
    options.order?.workstreams,
    (section) => section.id,
    "last",
  );
  for (const section of orderedSections) {
    const g = group(section.id, section.name);
    const quiet = options.now - g.lastActiveAt > dormantAfterMs;
    if (g.prioritized) pinned.push(g);
    else if (g.total === 0) empty.push(g);
    else if (quiet && g.needsYou === 0) dormant.push(g);
    else groups.push(g);
  }
  groups.push(...empty);

  const byAttention = (a: Row<T>, b: Row<T>) =>
    b.thread.latestAttentionAt - a.thread.latestAttentionAt ||
    a.thread.id.localeCompare(b.thread.id);
  const all = [...rowOf.values()];
  const needsYouRows = all.filter(counts).sort(byAttention);
  const recent = all
    .filter((row) => row.depth === 0 && !row.needsYou)
    .sort(byAttention)
    .slice(0, recentLimit);

  const wakeRank = (node: TreeNode<T>) =>
    wakeOf(node.thread) ?? Number.POSITIVE_INFINITY;
  const snoozed: Row<T>[] = [];
  for (const node of snoozedNodes.sort(
    (a, b) => wakeRank(a) - wakeRank(b) || compareRoots(a.thread, b.thread),
  )) {
    const root = forest.rootOf.get(node.thread.id) ?? node.thread;
    const key = groupKeyOf(root);
    for (const child of flatten(node)) {
      const row: Row<T> = {
        thread: child.thread,
        depth: child.depth - node.depth,
        hasChildren: child.children.length > 0,
        workstreamId: key === UNSORTED_ID ? null : key,
        needsYou: needsYou(child.thread),
      };
      snoozed.push(row);
      rowOf.set(child.thread.id, row);
    }
  }

  return {
    needsYou: needsYouRows,
    recent,
    groups: [...pinned, ...groups],
    unsorted: group(UNSORTED_ID, "Unsorted"),
    dormant,
    snoozed,
    rowOf,
    needsYouVia,
  };
}

/**
 * Up Next split by priority. While any prioritized workstream has a thread in
 * Up Next, `shown` holds only those, plus each row `keep` names, and
 * `elsewhere` the rest, which Up Next leaves out; otherwise every row is
 * shown. `keep` lets the sidebar
 * hold the row the user has open so focus never pulls it out from under them.
 * Both lists keep the incoming order.
 */
export function focusNeeds<T extends WorkstreamThread>(
  rows: readonly Row<T>[],
  isPrioritized: (workstreamId: string | null) => boolean,
  keep: (row: Row<T>) => boolean = () => false,
): {
  readonly active: boolean;
  readonly shown: readonly Row<T>[];
  readonly elsewhere: readonly Row<T>[];
} {
  const focused = (row: Row<T>) => isPrioritized(row.workstreamId);
  if (!rows.some(focused))
    return { active: false, shown: [...rows], elsewhere: [] };
  const shown: Row<T>[] = [];
  const elsewhere: Row<T>[] = [];
  for (const row of rows)
    (focused(row) || keep(row) ? shown : elsewhere).push(row);
  return { active: true, shown, elsewhere };
}

/** Page order: most needs-you first, then most recent attention. */
export function rankGroups<T extends WorkstreamThread>(
  groups: readonly Group<T>[],
): Group<T>[] {
  return [...groups].sort(
    (a, b) =>
      b.needsYou - a.needsYou ||
      b.lastActiveAt - a.lastActiveAt ||
      a.name.localeCompare(b.name),
  );
}
