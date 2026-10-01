import type { Projection, WorkstreamThread } from "./project.ts";

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
