/**
 * What the phone Home screen lists, decided from the shared projection: Up
 * Next, the workstream groups, and the Snoozed fold, by the same rules as the
 * sidebar (see `selectUpNext` and `arrangeGroups`). Pure, so tests can check
 * membership, order, and defaults without rendering.
 *
 * Home is a place to pick a thread, so workstreams with no threads are left
 * out (the New work picker still offers them), and so is the Archived fold.
 */
import {
  arrangeGroups,
  focusedSections,
  type GroupSort,
  type WorkstreamNode,
  type WorkstreamTopics,
} from "../../domain/groups.ts";
import type { ManualOrder } from "../../domain/order.ts";
import type {
  Group,
  Projection,
  Row,
  WorkstreamThread,
} from "../../domain/project.ts";
import {
  selectUpNext,
  type UpNextOptions,
  type UpNextThread,
} from "../../domain/upNext.ts";

export type HomePlan<T extends WorkstreamThread> = {
  /** Up Next's rows (see `selectUpNext`); null when none. */
  readonly upNext: { readonly rows: readonly Row<T>[] } | null;
  /**
   * Focus, which holds whether or not Up Next shows: while a focused
   * workstream has a thread blocked on the user, Up Next lists only focused
   * workstreams' threads, and the count of those blocked elsewhere rides on
   * the other-workstreams toggle.
   */
  readonly focus: {
    readonly active: boolean;
    /** How many threads blocked on the user focus left out. */
    readonly elsewhere: number;
  };
  /** Focused workstreams with threads, in the chosen order. */
  readonly pinned: readonly WorkstreamNode<T>[];
  /** The other workstreams with threads, in the chosen order. */
  readonly populated: readonly WorkstreamNode<T>[];
  /** Threads in no workstream; null while there are none. */
  readonly unfiled: Group<T> | null;
  /** Workstreams quiet for 30 days. */
  readonly dormant: readonly WorkstreamNode<T>[];
  /**
   * Some focused workstream has threads to show above the rest, which then
   * hide behind a toggle. A focused workstream with no active threads (all
   * snoozed, say) pins nothing, so it tiers nothing.
   */
  readonly tiered: boolean;
  /** Anything remains below the focused workstreams. */
  readonly hasLower: boolean;
  readonly snoozed: readonly Row<T>[];
  /** Workstreams (and Unfiled) with threads, outside Dormant. */
  readonly populatedCount: number;
  /** Nothing at all would show. */
  readonly isEmpty: boolean;
};

/** The focused workstreams that still exist. */
export function prioritizedSet(
  order: ManualOrder,
  sections: readonly { readonly id: string }[],
): Set<string> {
  const known = new Set(sections.map((section) => section.id));
  return new Set(order.prioritized.filter((id) => known.has(id)));
}

export function planHome<T extends UpNextThread>(
  projection: Projection<T>,
  options: UpNextOptions<T> & {
    /** Focused section ids (`ManualOrder.prioritized`). */
    prioritized: ReadonlySet<string>;
    groupSort: GroupSort;
    showUpNext: boolean;
    showSnoozed: boolean;
    /** What nests the workstreams; without it each stands alone. */
    topics?: WorkstreamTopics;
  },
): HomePlan<T> {
  const arranged = arrangeGroups(projection, options.groupSort, options.topics);
  const selection = selectUpNext(projection, {
    kindOf: options.kindOf,
    now: options.now,
    prioritized: focusedSections(arranged, options.prioritized),
  });
  const upNext =
    options.showUpNext && selection.rows.length > 0
      ? { rows: selection.rows }
      : null;
  const populated = (groups: readonly WorkstreamNode<T>[]) =>
    groups.filter((group) => group.total > 0);
  const pinned = populated(arranged.pinned);
  const others = populated(arranged.populated);
  const unfiled = arranged.unfiled.total > 0 ? arranged.unfiled : null;
  const dormant = populated(arranged.dormant);
  const snoozed = options.showSnoozed ? projection.snoozed : [];
  const populatedCount = pinned.length + others.length + (unfiled ? 1 : 0);
  return {
    upNext,
    focus: {
      active: selection.focused,
      elsewhere: selection.elsewhere.length,
    },
    pinned,
    populated: others,
    unfiled,
    dormant,
    tiered: pinned.length > 0,
    hasLower: others.length > 0 || unfiled !== null || dormant.length > 0,
    snoozed,
    populatedCount,
    isEmpty:
      !upNext &&
      populatedCount === 0 &&
      dormant.length === 0 &&
      !snoozed.length,
  };
}

/**
 * Whether a workstream starts expanded. Focused ones do, as does the only
 * workstream there is, so a first look is never a lone closed header; the rest
 * start closed so the screen reads as an index of the work in flight.
 */
export function startsOpen<T extends WorkstreamThread>(
  plan: HomePlan<T>,
  group: Group<T>,
): boolean {
  return group.prioritized || plan.populatedCount <= 1;
}

/**
 * A group's rows without those beneath a folded ancestor. `rows` must be in
 * tree order, as the projection emits them.
 */
export function unfoldedRows<T extends WorkstreamThread>(
  rows: readonly Row<T>[],
  isFolded: (row: Row<T>) => boolean,
): Row<T>[] {
  const out: Row<T>[] = [];
  let hideBelow: number | null = null;
  for (const row of rows) {
    if (hideBelow !== null && row.depth > hideBelow) continue;
    hideBelow = null;
    out.push(row);
    if (row.hasChildren && isFolded(row)) hideBelow = row.depth;
  }
  return out;
}

/** How many threads sit beneath `rows[index]`, in a tree-ordered list. */
export function descendantCount<T extends WorkstreamThread>(
  rows: readonly Row<T>[],
  index: number,
): number {
  const depth = rows[index]?.depth ?? 0;
  let count = 0;
  for (const row of rows.slice(index + 1)) {
    if (row.depth <= depth) break;
    count += 1;
  }
  return count;
}
