/**
 * What the phone Home screen lists, decided from the shared projection: Up
 * Next, the workstream groups, and the Snoozed fold, by the same rules as the
 * sidebar (see `selectUpNext` and `arrangeGroups`). Pure, so tests can check
 * membership, order, and defaults without rendering.
 *
 * Home is a place to pick a thread, so workstreams with no threads are left
 * out (the New work picker still offers them), and so is the Archived fold.
 */
import { arrangeGroups, type GroupSort } from "../../domain/groups.ts";
import type { ManualOrder } from "../../domain/order.ts";
import type {
  Group,
  Projection,
  Row,
  WorkstreamThread,
} from "../../domain/project.ts";
import { selectUpNext } from "../../domain/upNext.ts";

export type HomePlan<T extends WorkstreamThread> = {
  /** Up Next after prioritized focus, before the row limit; null when none. */
  readonly upNext: {
    readonly rows: readonly Row<T>[];
    /** Focus left other workstreams' waiting threads out of the rows. */
    readonly focused: boolean;
    /** How many waiting threads focus left out. */
    readonly elsewhere: number;
  } | null;
  /** Prioritized workstreams with threads, in the chosen order. */
  readonly pinned: readonly Group<T>[];
  /** The other workstreams with threads, in the chosen order. */
  readonly populated: readonly Group<T>[];
  /** Threads in no workstream; null while there are none. */
  readonly unfiled: Group<T> | null;
  /** Workstreams quiet for 30 days. */
  readonly dormant: readonly Group<T>[];
  /** Some workstream is prioritized, so the rest are lower priority. */
  readonly tiered: boolean;
  /** Anything remains below the prioritized workstreams. */
  readonly hasLower: boolean;
  readonly snoozed: readonly Row<T>[];
  /** Workstreams (and Unfiled) with threads, outside Dormant. */
  readonly populatedCount: number;
  /** Nothing at all would show. */
  readonly isEmpty: boolean;
};

/** The prioritized workstreams that still exist. */
export function prioritizedSet(
  order: ManualOrder,
  sections: readonly { readonly id: string }[],
): Set<string> {
  const known = new Set(sections.map((section) => section.id));
  return new Set(order.prioritized.filter((id) => known.has(id)));
}

export function planHome<T extends WorkstreamThread>(
  projection: Projection<T>,
  options: {
    recaps: Readonly<Record<string, unknown>>;
    prioritized: ReadonlySet<string>;
    groupSort: GroupSort;
    showUpNext: boolean;
    showSnoozed: boolean;
  },
): HomePlan<T> {
  const selection = selectUpNext(projection, {
    recaps: options.recaps,
    prioritized: options.prioritized,
  });
  const upNext =
    options.showUpNext && selection.rows.length > 0
      ? {
          rows: selection.rows,
          focused: selection.focus.active,
          elsewhere: selection.focus.elsewhere.length,
        }
      : null;
  const arranged = arrangeGroups(projection, options.groupSort);
  const populated = (groups: readonly Group<T>[]) =>
    groups.filter((group) => group.total > 0);
  const pinned = populated(arranged.pinned);
  const others = populated(arranged.populated);
  const unfiled = arranged.unfiled.total > 0 ? arranged.unfiled : null;
  const dormant = populated(arranged.dormant);
  const snoozed = options.showSnoozed ? projection.snoozed : [];
  const populatedCount = pinned.length + others.length + (unfiled ? 1 : 0);
  return {
    upNext,
    pinned,
    populated: others,
    unfiled,
    dormant,
    tiered: arranged.tiered,
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
 * Whether a workstream starts expanded. Prioritized ones do, as does the only
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
