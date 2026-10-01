/**
 * Presentation facts derived from BB's live thread state. BB resolves a
 * thread's status into an `indicator`; the SDK ships no glyphs, so each list
 * draws its own. Unknown indicator kinds (BB adds them over time) fall back to
 * no glyph rather than a wrong one.
 */

export type StatusRole = "working" | "waiting" | "error" | "unread" | "draft";

export function statusRole(indicator: string): StatusRole | null {
  switch (indicator) {
    case "runtime":
    case "workflow":
    case "background-agent":
    case "background-command":
    case "plan-mode":
    case "goal":
      return "working";
    case "waiting-for-input":
    case "queued-waiting":
      return "waiting";
    case "unread-error":
    case "queued-failed":
      return "error";
    case "unread-success":
      return "unread";
    case "draft":
    case "working-draft":
      return "draft";
    default:
      return null;
  }
}

export const STATUS_LABEL: Record<StatusRole, string> = {
  working: "Working",
  waiting: "Waiting for you",
  error: "Failed",
  unread: "Finished, unread",
  draft: "Unsent draft",
};

/** Compact age: "now", "5m", "3h", "2d", "6w". */
export function relativeAge(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/**
 * Work-state glyphs, drawn beside BB's own status mark. `in_progress` and an
 * inferred `done` draw nothing: most threads are in one of those states, so
 * a mark on them would be noise. A thread whose agent reported its turn
 * complete draws REPORTED_DONE instead.
 */
export const WORK_STATE: Record<
  "needs_decision" | "review" | "blocked" | "in_progress" | "done",
  { glyph: string | null; label: string }
> = {
  needs_decision: { glyph: "◆", label: "Needs your decision" },
  review: { glyph: "◇", label: "Ready for your review" },
  // U+FE0E keeps the pause sign from rendering as an emoji.
  blocked: { glyph: "\u23F8\uFE0E", label: "Blocked on something else" },
  in_progress: { glyph: null, label: "In progress" },
  done: { glyph: null, label: "Done" },
};

/** A turn the thread's agent reported complete in its recap. */
export const REPORTED_DONE = { glyph: "\u2713", label: "Complete" } as const;

/** The mark for a work state, given whether the thread's agent reported it. */
export function workStateMark(
  state: keyof typeof WORK_STATE,
  reported: boolean,
): { glyph: string | null; label: string } {
  return reported && state === "done" ? REPORTED_DONE : WORK_STATE[state];
}
