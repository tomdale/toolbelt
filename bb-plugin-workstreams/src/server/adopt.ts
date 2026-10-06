/**
 * Names the threads BB never titled from the goal analysis already stored for
 * them (SPEC §10.1), once.
 *
 * A thread's goal is its title, but a thread analyzed before that was so has a
 * stored goal and no title: its sidebar row shows BB's placeholder, the
 * opening words of its first request, until its next turn is analyzed. This
 * gives each such thread its stored goal now, so every surface shows the same
 * name at once. It goes through the ordinary retitle policy, so a thread that
 * is running or has moved on since its analysis is left for its
 * next analysis, and each title is a journaled change with Undo.
 */
import { GOAL_MAX } from "../domain/analysis.ts";
import { getMeta, setMeta, type Database } from "./db.ts";
import type { InventoryThread } from "./inventory.ts";

/** The `ws_meta` key that records the pass has been made. */
export const ADOPTED_KEY = "goal_titles_adopted";

export const ADOPTION_RATIONALE = "Titled from the thread's stored goal";

type StoredGoal = { readonly goal: string | null; readonly revision: number };

export async function adoptStoredGoals(deps: {
  db: Database;
  /** The reconciler's view of BB's active threads. */
  threads: () => readonly InventoryThread[];
  analysis: (threadId: string) => StoredGoal | undefined;
  /** Whether Workstreams may write titles (`threads.autoTitle`). */
  enabled: () => boolean;
  retitle: (
    threadId: string,
    goal: string,
    revision: number,
    rationale: string,
  ) => Promise<{ entry: unknown | null }>;
  log: (message: string) => void;
}): Promise<number> {
  if (getMeta(deps.db, ADOPTED_KEY) === "1") return 0;
  // Waits for the setting rather than spending the pass.
  if (!deps.enabled()) return 0;
  // An empty inventory is BB or the reconciler not ready, not a finished pass.
  const threads = deps.threads();
  if (threads.length === 0) return 0;
  let adopted = 0;
  let complete = true;
  for (const thread of threads) {
    if (
      thread.ownTitle !== null ||
      thread.status !== "idle" ||
      thread.isHidden ||
      thread.isArchived
    )
      continue;
    const stored = deps.analysis(thread.id);
    // A goal carried over from before goals were capped can be too long for a
    // title; that thread is named by its next analysis.
    if (!stored?.goal || stored.goal.length > GOAL_MAX) continue;
    try {
      const { entry } = await deps.retitle(
        thread.id,
        stored.goal,
        stored.revision,
        ADOPTION_RATIONALE,
      );
      if (entry) adopted++;
    } catch (error) {
      complete = false;
      deps.log(`Adopting the goal of ${thread.id} failed: ${String(error)}`);
    }
  }
  // A pass that hit a BB failure is made again; skipped threads are not a
  // failure, since their next analysis names them.
  if (complete) setMeta(deps.db, ADOPTED_KEY, "1");
  return adopted;
}
