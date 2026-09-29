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
