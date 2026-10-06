/**
 * Thread title ownership and the retitle policy (SPEC §10.1). Pure, so the
 * server and tests share one definition.
 *
 * A thread's title is its goal. BB exposes no provenance for a title, and
 * emits no event when one changes (SPEC §3). Ownership is therefore inferred
 * from the sequence of raw titles Workstreams has observed. BB's own title
 * generator only fills a title that is still empty, so a change from one title
 * to another that Workstreams did not write was made by the user or an agent,
 * and is never overridden.
 */

/** What Workstreams knows about one thread's title. */
export type TitleRecord = {
  /** The raw title (`null` when untitled) as last observed. */
  readonly observed: string | null;
  /** The title Workstreams last wrote, if any. */
  readonly written: string | null;
  /** Someone else chose this title: never retitle it automatically. */
  readonly locked: boolean;
  /** When Workstreams last retitled the thread. */
  readonly retitledAt: number | null;
  /**
   * `written` was inferred from the opening request alone, while the first
   * turn was still running. Full analysis settles it after the first turn.
   */
  readonly provisional: boolean;
};

/**
 * Folds one observation of a thread's raw title into its record. A first
 * observation is trusted as BB's own: a title that was already there can't be
 * told apart from a generated one.
 */
export function observeTitle(
  record: TitleRecord | undefined,
  raw: string | null,
): TitleRecord {
  if (!record)
    return {
      observed: raw,
      written: null,
      locked: false,
      retitledAt: null,
      provisional: false,
    };
  if (raw === record.observed) return record;
  // Clearing a title hands it back to automatic titling.
  if (raw === null)
    return { ...record, observed: null, locked: false, provisional: false };
  const renamedElsewhere = record.observed !== null && raw !== record.written;
  return {
    ...record,
    observed: raw,
    locked: record.locked || renamedElsewhere,
    provisional: record.provisional && !renamedElsewhere,
  };
}

const same = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim().toLowerCase() ===
  b.replace(/\s+/g, " ").trim().toLowerCase();

export type RetitleSkip =
  "no-suggestion" | "unchanged" | "stale" | "locked" | "titled";

/**
 * What a suggested title was inferred from.
 *
 * - `analysis`: the full analysis of a finished turn. The thread must still be
 *   idle at the analyzed revision.
 * - `opening`: the opening request alone, while the first turn is still
 *   running. It may only name a thread that has no title of its own, and only
 *   until that turn ends: its analysis names the thread from then on.
 */
export type RetitleBasis = "analysis" | "opening";

/**
 * Whether a suggested title may replace the thread's current one. `record`
 * must already include the thread's current raw title (`observeTitle`).
 */
export function retitleDecision(args: {
  record: TitleRecord;
  thread: {
    title: string | null;
    displayTitle: string;
    status: string;
    latestAttentionAt: number;
  };
  suggestion: string | null;
  /** The thread revision the suggestion was made for. */
  revision: number;
  basis: RetitleBasis;
}): { ok: true } | { ok: false; reason: RetitleSkip } {
  const { record, thread, suggestion } = args;
  if (!suggestion) return { ok: false, reason: "no-suggestion" };
  if (same(suggestion, thread.displayTitle))
    return { ok: false, reason: "unchanged" };
  if (args.basis === "opening") {
    // A turn that finished meanwhile is being analyzed, and that names it.
    if (thread.latestAttentionAt > args.revision)
      return { ok: false, reason: "stale" };
    if (record.locked) return { ok: false, reason: "locked" };
    // Never replace a title that appeared since the request: BB's generator,
    // the user, or an agent got there first.
    if (thread.title !== null) return { ok: false, reason: "titled" };
    return { ok: true };
  }
  // A newer or running turn may have moved the focus again.
  if (thread.status !== "idle" || thread.latestAttentionAt > args.revision)
    return { ok: false, reason: "stale" };
  if (record.locked) return { ok: false, reason: "locked" };
  return { ok: true };
}
