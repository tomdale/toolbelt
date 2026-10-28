import type { Projection, Row, WorkstreamThread } from "./project.ts";
import type { UpNextKind } from "./status.ts";
import { selectUpNext, type UpNextThread } from "./upNext.ts";

/**
 * Where to go once `threadId` is archived: the top of Up Next when that
 * thread is blocked on the user or unread. Otherwise null, and the caller
 * stays in the workstream (see `nextThreadAfterArchive`) rather than jump to
 * a read thread that wants nothing.
 */
export function nextUpNextThreadAfterArchive<T extends UpNextThread>(
  projection: Projection<T>,
  threadId: string,
  kindOf: (thread: T) => UpNextKind,
  prioritized: readonly string[] = [],
): string | null {
  const top = selectUpNext(projection, {
    kindOf,
    prioritized: new Set(prioritized),
    exclude: (thread) => thread.id === threadId,
  }).rows[0]?.thread;
  return top && (top.isUnread || kindOf(top) !== "other") ? top.id : null;
}

/**
 * The Up Next row after `threadId`, wrapping to the top. A thread Up Next
 * doesn't list (nothing open, or one that just left) starts at the top.
 */
export function nextUpNextThread<T extends UpNextThread>(
  projection: Projection<T>,
  threadId: string | null,
  kindOf: (thread: T) => UpNextKind,
  prioritized: readonly string[] = [],
): Row<T> | null {
  const { rows } = selectUpNext(projection, {
    kindOf,
    prioritized: new Set(prioritized),
  });
  if (rows.length === 0) return null;
  const index = threadId
    ? rows.findIndex((row) => row.thread.id === threadId)
    : -1;
  if (index < 0) return rows[0] ?? null;
  if (rows.length < 2) return null;
  return rows[(index + 1) % rows.length] ?? null;
}

/** Follow group order, wrapping at the end without leaving the workstream. */
export function nextThreadAfterArchive<T extends WorkstreamThread>(
  projection: Projection<T>,
  threadId: string,
): string | null {
  const group = [
    ...projection.groups,
    projection.unsorted,
    ...projection.dormant,
  ].find((group) => group.rows.some((row) => row.thread.id === threadId));
  if (!group) return null;
  const index = group.rows.findIndex((row) => row.thread.id === threadId);
  const current = group.rows[index]!;
  let after = index + 1;
  // Archiving a parent puts away its subtree; don't open a descendant.
  while (after < group.rows.length && group.rows[after]!.depth > current.depth)
    after++;
  const next = group.rows[after] ?? (index > 0 ? group.rows[0] : undefined);
  return next?.thread.id ?? null;
}
