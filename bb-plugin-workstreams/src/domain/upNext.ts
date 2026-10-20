/*
 * The sidebar and phone Home screen share Up Next membership and ordering:
 * top-level threads waiting on the user (see `focusNeeds` for prioritized
 * focus), then other top-level threads with a recap for their latest turn,
 * newest first. Parent links determine eligibility even when a parent is
 * absent from the visible tree.
 */
import {
  focusNeeds,
  type Projection,
  type Row,
  type WorkstreamThread,
} from "./project.ts";

/** Up Next shows this many rows until the user asks for the rest. */
export const UP_NEXT_LIMIT = 5;

export type UpNextSelection<T extends WorkstreamThread> = {
  /** Prioritized focus, applied to the threads waiting on the user. */
  readonly focus: ReturnType<typeof focusNeeds<T>>;
  /** Threads with a recap for their latest turn that join the waiting ones. */
  readonly recapRows: readonly Row<T>[];
  /** Every row Up Next lists, in order, before the row limit. */
  readonly rows: readonly Row<T>[];
};

export function selectUpNext<T extends WorkstreamThread>(
  projection: Projection<T>,
  options: {
    /** Threads waiting on the user; defaults to the projection's. */
    needsYou?: readonly Row<T>[];
    /** The thread ids that have a recap for their latest turn. */
    recaps: Readonly<Record<string, unknown>>;
    /** Prioritized workstream ids (section ids that still exist). */
    prioritized: ReadonlySet<string>;
    /** Rows focus must not take away, such as the thread the user has open. */
    keep?: (row: Row<T>) => boolean;
  },
): UpNextSelection<T> {
  const focus = focusNeeds(
    (options.needsYou ?? projection.needsYou).filter(
      (row) => !row.thread.parentThreadId,
    ),
    (id) => id !== null && options.prioritized.has(id),
    options.keep,
  );
  const recapRows = [
    ...projection.groups,
    projection.unsorted,
    ...projection.dormant,
  ]
    .flatMap((group) => group.rows)
    .filter(
      (row) => !row.thread.parentThreadId && options.recaps[row.thread.id],
    )
    .sort(
      (a, b) =>
        b.thread.latestAttentionAt - a.thread.latestAttentionAt ||
        a.thread.id.localeCompare(b.thread.id),
    )
    .filter(
      (row) =>
        (!focus.active ||
          (row.workstreamId !== null &&
            options.prioritized.has(row.workstreamId))) &&
        !focus.shown.some((shown) => shown.thread.id === row.thread.id),
    );
  return { focus, recapRows, rows: [...focus.shown, ...recapRows] };
}
