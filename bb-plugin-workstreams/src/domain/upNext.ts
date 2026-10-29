/**
 * Up Next's membership and order, shared by the sidebar, the phone Home
 * screen, and the next-Up-Next command so they always list the same threads.
 *
 * Every top-level thread that is in a group (not archived, hidden, or
 * snoozed) is a candidate, except one whose turn is underway and asks
 * nothing of the user (see `isRunning`). A question or a review is blocked
 * on the user; anything else (done, waiting on something else, failed) is
 * not. A review or a needed decision whose turn ended more than
 * {@link UP_NEXT_STALE_AFTER_MS} ago has gone stale and ranks as neither
 * (see `agedKind`). While a focused workstream has a thread blocked on the
 * user, only focused workstreams' threads are candidates; the threads
 * blocked on the user elsewhere wait outside Up Next.
 *
 * Candidates rank by tier, then by latest attention (BB's turn-end time,
 * the one unread compares against), newest first:
 *
 * 1. unread questions  2. unread reviews  3. read questions
 * 4. read reviews      5. other unread    6. other read
 * 7. unread waiting    8. read waiting
 *
 * "Waiting" threads are still waiting on something else (a subagent, a
 * timer), so they come after every other thread, even read ones.
 *
 * The list then trims from the least urgent end: threads not blocked on the
 * user leave, bottom first, until {@link UP_NEXT_LIMIT} remain; read
 * blocked threads leave until {@link UP_NEXT_MAX} remain; and past that,
 * only the most recently active {@link UP_NEXT_MAX} stay, whatever their
 * tier. So Up Next always holds a few threads, grows only for threads
 * blocked on the user, and stays short enough to act on. The trimmed
 * threads that are unread or blocked on the user wait behind Show more.
 *
 * Nested threads never appear on their own (BB doesn't mark a delegate
 * unread when its turn ends); they show under their root's row. Parent
 * links decide this even when the parent is absent from the visible tree.
 */
import {
  DAY_MS,
  type Projection,
  type Row,
  type WorkstreamThread,
} from "./project.ts";
import type { UpNextKind } from "./status.ts";

/** Up Next trims threads not blocked on the user down to this many rows. */
export const UP_NEXT_LIMIT = 5;
/** Up Next never lists more than this many rows. */
export const UP_NEXT_MAX = 10;
/** How long a finished turn's review or decision stays blocked on the user. */
export const UP_NEXT_STALE_AFTER_MS = 7 * DAY_MS;

export type UpNextThread = WorkstreamThread & {
  readonly isUnread: boolean;
  /** BB's execution status; unknown values count as idle. */
  readonly status: string;
};

/** BB's statuses for a turn underway, from queued to winding down. */
const RUNNING_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "starting",
  "active",
  "stopping",
]);

/**
 * The thread's turn is underway and asks nothing of the user, so Up Next
 * leaves it out: there is nothing to act on yet, and it returns, unread,
 * when the turn ends. A pending question card or approval keeps a running
 * thread in, since the agent is waiting on the user.
 */
export function isRunning(
  thread: Pick<UpNextThread, "status" | "hasPendingInteraction">,
): boolean {
  return RUNNING_STATUSES.has(thread.status) && !thread.hasPendingInteraction;
}

/** What Up Next ranks by; every caller that wants Up Next's rows passes it. */
export type UpNextOptions<T extends UpNextThread> = {
  /** What each thread is blocked on the user for (see `upNextKind`). */
  readonly kindOf: (thread: T) => UpNextKind;
  /** The current time, for aging out stale threads (see `agedKind`). */
  readonly now: number;
  /** Focused workstream ids (`ManualOrder.prioritized`); none, no focus. */
  readonly prioritized?: ReadonlySet<string>;
};

/** A question or review: the thread is blocked on the user. */
export function isBlockedOnUser(kind: UpNextKind): boolean {
  return kind === "question" || kind === "review";
}

/**
 * `kind` once age is counted: a review or needed decision whose turn ended
 * (its latest attention) more than {@link UP_NEXT_STALE_AFTER_MS} before
 * `now` ranks as `other`, keeping its read state. A pending question card or
 * approval never ages: the agent is waiting right now, and latest attention
 * dates the previous turn's end, not the question.
 */
export function agedKind(
  thread: Pick<UpNextThread, "hasPendingInteraction" | "latestAttentionAt">,
  kind: UpNextKind,
  now: number,
): UpNextKind {
  return isBlockedOnUser(kind) &&
    !thread.hasPendingInteraction &&
    now - thread.latestAttentionAt > UP_NEXT_STALE_AFTER_MS
    ? "other"
    : kind;
}

export type UpNextSelection<T extends WorkstreamThread> = {
  /** Up Next's rows, most urgent first. */
  readonly rows: readonly Row<T>[];
  /**
   * What Show more reveals below `rows`: the trimmed threads that are
   * unread or blocked on the user, most urgent first. Read threads not
   * blocked on the user stay out; Recent and the groups list them.
   */
  readonly more: readonly Row<T>[];
  /** Up Next lists only focused workstreams' threads. */
  readonly focused: boolean;
  /** Threads blocked on the user that focus left out, most urgent first. */
  readonly elsewhere: readonly Row<T>[];
};

/** Tier rank, 0 most urgent; see the module comment. */
function tierOf(kind: UpNextKind, unread: boolean): number {
  if (kind === "other") return unread ? 4 : 5;
  if (kind === "waiting") return unread ? 6 : 7;
  return (unread ? 0 : 2) + (kind === "review" ? 1 : 0);
}

const byAttention = (a: Row<WorkstreamThread>, b: Row<WorkstreamThread>) =>
  b.thread.latestAttentionAt - a.thread.latestAttentionAt ||
  a.thread.id.localeCompare(b.thread.id);

export function selectUpNext<T extends UpNextThread>(
  projection: Projection<T>,
  options: UpNextOptions<T> & {
    /** Threads to leave out before ranking, such as one being archived. */
    readonly exclude?: (thread: T) => boolean;
  },
): UpNextSelection<T> {
  const ranked = [
    ...projection.groups,
    projection.unsorted,
    ...projection.dormant,
  ]
    .flatMap((group) => group.rows)
    .filter(
      (row) =>
        !row.thread.parentThreadId &&
        !isRunning(row.thread) &&
        !options.exclude?.(row.thread),
    )
    .map((row) => {
      const kind = agedKind(
        row.thread,
        options.kindOf(row.thread),
        options.now,
      );
      return {
        row,
        onYou: isBlockedOnUser(kind),
        unread: row.thread.isUnread,
        tier: tierOf(kind, row.thread.isUnread),
        prioritized:
          row.workstreamId !== null &&
          (options.prioritized?.has(row.workstreamId) ?? false),
      };
    })
    .sort((a, b) => a.tier - b.tier || byAttention(a.row, b.row));

  const focused = ranked.some((entry) => entry.prioritized && entry.onYou);
  const pool = focused ? ranked.filter((entry) => entry.prioritized) : ranked;
  let shown = pool;
  /** Drops `removable` entries from the least urgent end until `target`. */
  const trim = (
    target: number,
    removable: (entry: (typeof ranked)[number]) => boolean,
  ) => {
    let excess = shown.length - target;
    if (excess <= 0) return;
    const kept: typeof ranked = [];
    for (const entry of [...shown].reverse()) {
      if (excess > 0 && removable(entry)) excess -= 1;
      else kept.push(entry);
    }
    shown = kept.reverse();
  };
  trim(UP_NEXT_LIMIT, (entry) => !entry.onYou);
  trim(UP_NEXT_MAX, (entry) => entry.onYou && !entry.unread);
  if (shown.length > UP_NEXT_MAX) {
    const newest = new Set(
      shown
        .map((entry) => entry.row)
        .sort(byAttention)
        .slice(0, UP_NEXT_MAX),
    );
    shown = shown.filter((entry) => newest.has(entry.row));
  }
  const inUpNext = new Set(shown);
  return {
    rows: shown.map((entry) => entry.row),
    more: pool
      .filter((entry) => !inUpNext.has(entry) && (entry.unread || entry.onYou))
      .map((entry) => entry.row),
    focused,
    elsewhere: focused
      ? ranked
          .filter((entry) => !entry.prioritized && entry.onYou)
          .map((entry) => entry.row)
      : [],
  };
}

/**
 * Recent: the most recently active threads at the top of their trees that
 * Up Next doesn't show, newest first, so Recent carries on where Up Next
 * stops and the two never repeat a thread. `shown` is what Up Next draws,
 * including any row it holds in place.
 */
export function selectRecent<T extends WorkstreamThread>(
  projection: Projection<T>,
  shown: readonly Row<T>[],
  limit: number,
): Row<T>[] {
  const inUpNext = new Set(shown.map((row) => row.thread.id));
  return [...projection.groups, projection.unsorted, ...projection.dormant]
    .flatMap((group) => group.rows)
    .filter((row) => row.depth === 0 && !inUpNext.has(row.thread.id))
    .sort(byAttention)
    .slice(0, limit);
}

/**
 * `rows` with `held` at `index` (or last, when the list has shrunk), moved
 * there if the rows already list it. The sidebar holds the open thread's
 * row where the user found it, so reading it never moves the row out from
 * under them; a negative index or no row holds nothing.
 */
export function holdInPlace<T extends WorkstreamThread>(
  rows: readonly Row<T>[],
  held: Row<T> | undefined,
  index: number,
): Row<T>[] {
  if (!held || index < 0) return [...rows];
  const rest = rows.filter((row) => row.thread.id !== held.thread.id);
  rest.splice(Math.min(index, rest.length), 0, held);
  return rest;
}
