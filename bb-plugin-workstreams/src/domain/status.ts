/**
 * A thread's work status: one rule for every surface and for the organizer.
 *
 * The thread's agent reports how its turn ended through the recap tool, and
 * that report outranks analysis for the turn it describes. Analysis supplies
 * the status of turns the agent didn't report, and the goal either way. The
 * sidebar, the page, the phone Home screen, the CLI, the organizer, and
 * routing all read status through this module so they never disagree about
 * whether a thread is done or waiting on you.
 */
import { isCurrent, type StoredAnalysis } from "./analysis.ts";
import { reportedAnalysis, type Recap } from "./recap.ts";

/**
 * What is known about a thread's latest turn: nothing, a pending marker over
 * the previous result, or the current result. `reported` marks a result the
 * thread's agent reported in its recap rather than one analysis inferred.
 */
export type WorkView =
  | { kind: "none" }
  | { kind: "pending"; previous: StoredAnalysis }
  | { kind: "current"; analysis: StoredAnalysis; reported: boolean };

/** The thread fields status depends on. */
export type StatusThread = {
  readonly status: string;
  readonly latestAttentionAt: number;
};

/**
 * The agent's recap of an idle thread's latest turn outranks analysis for
 * the work state and the one-line summary; a current analysis still supplies
 * the goal. A stored recap always describes the latest turn, because fresh
 * input clears it.
 */
export function workView(
  thread: StatusThread,
  analysis: StoredAnalysis | undefined,
  recap?: Recap,
): WorkView {
  // A failed turn gets neither; BB's own error mark says enough.
  if (thread.status === "error") return { kind: "none" };
  if (recap && thread.status === "idle")
    return {
      kind: "current",
      reported: true,
      analysis: reportedAnalysis(
        recap,
        thread,
        isCurrent(analysis, thread) ? analysis : undefined,
      ),
    };
  if (!analysis) return { kind: "none" };
  return isCurrent(analysis, thread)
    ? { kind: "current", analysis, reported: false }
    : { kind: "pending", previous: analysis };
}

/** Needs you: a pending interaction, or a current needs-decision result. */
export function needsYou(
  thread: { readonly hasPendingInteraction: boolean },
  work: WorkView,
): boolean {
  return (
    thread.hasPendingInteraction ||
    (work.kind === "current" && work.analysis.state === "needs_decision")
  );
}

/**
 * Done: the agent reported its turn complete, or analysis of the current
 * turn found the work finished. Done threads don't count toward a
 * workstream's active load.
 */
export function isDone(work: WorkView): boolean {
  return work.kind === "current" && work.analysis.state === "done";
}
