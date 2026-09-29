/**
 * The one projection behind the sidebar and the Workstreams page (SPEC I8).
 *
 * A workstream is a native BB section. Threads are grouped the way BB's own
 * sidebar groups them: build the complete parent/child forest first, then file
 * each tree under its root's section (SPEC I2). Every visible, non-archived
 * thread appears in exactly one group row (SPEC I1). Needs you and Recent are
 * overlays that reference those rows; they never replace them.
 */
import { buildForest, flatten, type TreeThread } from "./tree.ts";

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
};

export type Projection<T extends WorkstreamThread> = {
  readonly needsYou: readonly Row<T>[];
  readonly recent: readonly Row<T>[];
  /** Active workstreams, in BB's section order. */
  readonly groups: readonly Group<T>[];
  readonly unsorted: Group<T>;
  /** Workstreams with no visible threads, or none active within the window. */
  readonly dormant: readonly Group<T>[];
  readonly rowOf: ReadonlyMap<string, Row<T>>;
  /**
   * Children whose question folded into their parent's newer one, keyed by
   * parent id. Folded children stay in their group but leave the Needs you
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

  const rowsBySection = new Map<string, Row<T>[]>();
  const rowOf = new Map<string, Row<T>>();
  for (const root of forest.roots) {
    const sectionId = root.thread.sectionId;
    const workstreamId = sectionId && known.has(sectionId) ? sectionId : null;
    const key = workstreamId ?? UNSORTED_ID;
    const rows = rowsBySection.get(key) ?? [];
    for (const node of flatten(root)) {
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

  // A child's question folds into its parent when the parent's own
  // needs-you turn is at least as recent (SPEC §10: timestamps only).
  const needsYouVia = new Map<string, T[]>();
  const folded = new Set<string>();
  for (const row of rowOf.values()) {
    if (!row.needsYou || !row.thread.parentThreadId) continue;
    const parent = rowOf.get(row.thread.parentThreadId);
    if (
      !parent?.needsYou ||
      parent.thread.latestAttentionAt < row.thread.latestAttentionAt
    )
      continue;
    folded.add(row.thread.id);
    needsYouVia.set(parent.thread.id, [
      ...(needsYouVia.get(parent.thread.id) ?? []),
      row.thread,
    ]);
  }
  const counts = (row: Row<T>) => row.needsYou && !folded.has(row.thread.id);

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
    };
  };

  const groups: Group<T>[] = [];
  const dormant: Group<T>[] = [];
  for (const section of sections) {
    const g = group(section.id, section.name);
    const quiet = options.now - g.lastActiveAt > dormantAfterMs;
    if (g.total === 0 || (quiet && g.needsYou === 0)) dormant.push(g);
    else groups.push(g);
  }

  const byAttention = (a: Row<T>, b: Row<T>) =>
    b.thread.latestAttentionAt - a.thread.latestAttentionAt ||
    a.thread.id.localeCompare(b.thread.id);
  const all = [...rowOf.values()];
  const needsYouRows = all.filter(counts).sort(byAttention);
  const recent = all
    .filter((row) => !row.needsYou)
    .sort(byAttention)
    .slice(0, recentLimit);

  return {
    needsYou: needsYouRows,
    recent,
    groups,
    unsorted: group(UNSORTED_ID, "Unsorted"),
    dormant,
    rowOf,
    needsYouVia,
  };
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
