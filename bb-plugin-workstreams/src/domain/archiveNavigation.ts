import {
  focusNeeds,
  type Projection,
  type WorkstreamThread,
} from "./project.ts";

/** Follow group order, wrapping at the end without leaving the workstream. */
export function nextUpNextThreadAfterArchive<T extends WorkstreamThread>(
  projection: Projection<T>,
  threadId: string,
  prioritized: readonly string[] = [],
): string | null {
  const rows = projection.needsYou.filter((row) => row.thread.id !== threadId);
  return (
    focusNeeds(rows, (id) => id !== null && prioritized.includes(id)).shown[0]
      ?.thread.id ?? null
  );
}

/** Advance through visible Up Next rows, starting at the top when unselected. */
export function nextUpNextThread<T extends WorkstreamThread>(
  projection: Projection<T>,
  threadId: string | null,
  prioritized: readonly string[] = [],
): Projection<T>["needsYou"][number] | null {
  const rows = focusNeeds(
    projection.needsYou,
    (id) => id !== null && prioritized.includes(id),
  ).shown;
  if (rows.length === 0) return null;
  const index = threadId
    ? rows.findIndex((row) => row.thread.id === threadId)
    : -1;
  if (index < 0) return rows[0] ?? null;
  if (rows.length < 2) return null;
  return rows[(index + 1) % rows.length] ?? null;
}

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
