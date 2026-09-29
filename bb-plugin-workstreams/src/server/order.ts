import { getMeta, setMeta, type Database } from "./db.ts";

const KEY = "sidebar-order";

/** A {@link ManualOrder} as stored and sent over RPC. */
export type StoredOrder = {
  workstreams: string[];
  threads: Record<string, string[]>;
};

/** The stored manual order (see `ManualOrder`); a missing or unreadable value is no order. */
export function loadOrder(db: Database): StoredOrder {
  try {
    const parsed = JSON.parse(
      getMeta(db, KEY) ?? "null",
    ) as Partial<StoredOrder> | null;
    return {
      workstreams: Array.isArray(parsed?.workstreams) ? parsed.workstreams : [],
      threads:
        parsed?.threads && typeof parsed.threads === "object"
          ? parsed.threads
          : {},
    };
  } catch {
    return { workstreams: [], threads: {} };
  }
}

/**
 * Replaces the workstream order, or one group's root thread order. An empty
 * thread list forgets the group's order, so it falls back to recency.
 */
export function saveOrder(
  db: Database,
  change:
    | { kind: "workstreams"; ids: readonly string[] }
    | { kind: "threads"; groupId: string; ids: readonly string[] },
): StoredOrder {
  const current = loadOrder(db);
  let next: StoredOrder;
  if (change.kind === "workstreams") {
    next = { ...current, workstreams: [...change.ids] };
  } else {
    const threads = { ...current.threads };
    if (change.ids.length) threads[change.groupId] = [...change.ids];
    else delete threads[change.groupId];
    next = { ...current, threads };
  }
  setMeta(db, KEY, JSON.stringify(next));
  return next;
}
