/**
 * How the workstream groups are arranged below Up Next, shared by the sidebar
 * and the phone Home screen: prioritized groups lead, the rest follow in the
 * chosen order with populated ones before empty ones, and Unfiled and Dormant
 * sit beside them. While any workstream is prioritized the rest are "lower
 * priority" and hide behind a toggle. Pure, so both surfaces agree.
 */
import type { Group, Projection, WorkstreamThread } from "./project.ts";

/** How workstream groups are ordered: by name, by recent activity, or as dragged. */
export type GroupSort = "alphabetical" | "activity" | "manual";

export function sortGroups<T extends WorkstreamThread>(
  groups: readonly Group<T>[],
  sort: GroupSort,
): Group<T>[] {
  if (sort === "manual") return [...groups];
  return [...groups].sort(
    (a, b) =>
      (sort === "activity"
        ? b.lastActiveAt - a.lastActiveAt
        : a.name.localeCompare(b.name)) || a.name.localeCompare(b.name),
  );
}

export type GroupArrangement<T extends WorkstreamThread> = {
  /** Prioritized workstreams, which pin below Up Next. */
  readonly pinned: readonly Group<T>[];
  /** Every other active workstream: populated ones, then empty ones. */
  readonly other: readonly Group<T>[];
  readonly populated: readonly Group<T>[];
  readonly empty: readonly Group<T>[];
  /** Workstreams with no recent activity, in the projection's order. */
  readonly dormant: readonly Group<T>[];
  /** The virtual group of threads in no workstream. */
  readonly unfiled: Group<T>;
  /** Some workstream is prioritized, so the rest are lower priority. */
  readonly tiered: boolean;
  /** There is anything below the prioritized groups to reveal. */
  readonly hasLower: boolean;
};

export function arrangeGroups<T extends WorkstreamThread>(
  projection: Projection<T>,
  sort: GroupSort,
): GroupArrangement<T> {
  const pinned = sortGroups(
    projection.groups.filter((group) => group.prioritized),
    sort,
  );
  const other = sortGroups(
    projection.groups.filter((group) => !group.prioritized),
    sort,
  );
  return {
    pinned,
    other,
    populated: other.filter((group) => group.total > 0),
    empty: other.filter((group) => group.total === 0),
    dormant: projection.dormant,
    unfiled: projection.unsorted,
    tiered: pinned.length > 0,
    hasLower:
      other.length > 0 ||
      projection.unsorted.total > 0 ||
      projection.dormant.length > 0,
  };
}
