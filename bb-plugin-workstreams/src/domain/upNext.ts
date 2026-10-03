/**
 * Which rows Up Next lists. The sidebar and the phone Home screen both show
 * the block, so they share this selection: threads waiting on the user (see
 * `focusNeeds` for prioritized focus), then every other thread whose agent
 * left a recap for its latest turn, newest first. Pure, so both surfaces and
 * tests agree on membership and order.
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
    options.needsYou ?? projection.needsYou,
    (id) => id !== null && options.prioritized.has(id),
    options.keep,
  );
  const recapRows = [
    ...projection.groups,
    projection.unsorted,
    ...projection.dormant,
  ]
    .flatMap((group) => group.rows)
    .filter((row) => options.recaps[row.thread.id])
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
