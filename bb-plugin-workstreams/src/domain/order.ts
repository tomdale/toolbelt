/**
 * The user's sidebar arrangement: the manual order set by drag and drop, and
 * the workstreams the user prioritized.
 *
 * BB keeps sections in creation order and threads by recency, so manual order
 * is the plugin's own state. It is sparse on purpose: an id the user never
 * placed keeps its natural position relative to the placed ones, so new work
 * still surfaces without the user re-sorting anything.
 */
export type ManualOrder = {
  /** Section ids, top to bottom. */
  readonly workstreams: readonly string[];
  /** Root thread ids, top to bottom, keyed by group id (section id or "unsorted"). */
  readonly threads: Readonly<Record<string, readonly string[]>>;
  /**
   * Prioritized section ids, as a set: prioritized workstreams pin above the
   * others in `workstreams` order, and focus Up Next (see `focusNeeds`).
   */
  readonly prioritized: readonly string[];
};

export const EMPTY_ORDER: ManualOrder = {
  workstreams: [],
  threads: {},
  prioritized: [],
};

/**
 * Sorts `items` by their position in `ids`. Unlisted items keep their
 * incoming relative order and go before the listed ones (`"first"`, so a new
 * thread shows at the top of its group) or after them (`"last"`, so a new
 * workstream lands at the bottom as it does in BB).
 */
export function applyOrder<T>(
  items: readonly T[],
  ids: readonly string[] | undefined,
  idOf: (item: T) => string,
  unlisted: "first" | "last",
): T[] {
  if (!ids?.length) return [...items];
  const rank = new Map(ids.map((id, index) => [id, index]));
  const listed = items
    .filter((item) => rank.has(idOf(item)))
    .sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!);
  const rest = items.filter((item) => !rank.has(idOf(item)));
  return unlisted === "first" ? [...rest, ...listed] : [...listed, ...rest];
}

/**
 * Moves `id` to sit before `beforeId` (or at the end when null) in `ids`,
 * inserting it when absent. The result is the full new order to store.
 */
export function placeBefore(
  ids: readonly string[],
  id: string,
  beforeId: string | null,
): string[] {
  const rest = ids.filter((other) => other !== id);
  const at = beforeId === null ? -1 : rest.indexOf(beforeId);
  if (at < 0) return [...rest, id];
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
