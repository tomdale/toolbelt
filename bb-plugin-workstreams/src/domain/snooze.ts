/**
 * Thread snoozes: a thread the user put away until later leaves For you,
 * Recent, and its workstream group for the sidebar's Snoozed fold, and comes
 * back on its own.
 *
 * A snooze either has a wake time, or waits for the thread's next activity
 * (`until: null`). Time-based snoozes ignore agent activity, so a long run
 * finishing overnight doesn't undo "tomorrow morning". Every snooze ends when
 * the user sends the thread a message (enforced by the server) or unsnoozes it.
 */

export type ThreadSnooze = {
  /** When the thread wakes; null waits for its next activity instead. */
  readonly until: number | null;
  /** The thread's `latestAttentionAt` when it was snoozed. */
  readonly attentionAt: number;
  readonly at: number;
};

/** The one-click and menu choices. Times are the user's local clock. */
export const SNOOZE_PRESETS = [
  { id: "1h", label: "1 hour" },
  { id: "3h", label: "3 hours" },
  { id: "tomorrow", label: "Tomorrow morning" },
  { id: "next-week", label: "Next week" },
  { id: "activity", label: "Until it updates" },
] as const;

export type SnoozePresetId = (typeof SNOOZE_PRESETS)[number]["id"];

/** The `snoozeDefault` setting stores a preset's label. */
export const SNOOZE_SETTING_OPTIONS = SNOOZE_PRESETS.map((p) => p.label);
export const DEFAULT_SNOOZE: SnoozePresetId = "tomorrow";

/** Mornings start at 9:00 local time. */
const MORNING_HOUR = 9;
const HOUR_MS = 60 * 60 * 1000;

export function presetFromSetting(value: unknown): SnoozePresetId {
  return (
    SNOOZE_PRESETS.find((p) => p.label === value || p.id === value)?.id ??
    DEFAULT_SNOOZE
  );
}

export function presetLabel(id: SnoozePresetId): string {
  return SNOOZE_PRESETS.find((p) => p.id === id)!.label;
}

/** When a preset chosen at `now` wakes the thread; null waits for activity. */
export function wakeTime(preset: SnoozePresetId, now: number): number | null {
  if (preset === "activity") return null;
  if (preset === "1h") return now + HOUR_MS;
  if (preset === "3h") return now + 3 * HOUR_MS;
  const date = new Date(now);
  date.setHours(MORNING_HOUR, 0, 0, 0);
  if (preset === "tomorrow") {
    date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  // Next week: the coming Monday morning, never today.
  const daysToMonday = (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + daysToMonday);
  return date.getTime();
}

/**
 * Whether a snooze still holds: its time hasn't come, or (for an activity
 * snooze) the thread hasn't had attention since it was snoozed.
 */
export function isSnoozed(
  snooze: ThreadSnooze | undefined,
  thread: { readonly latestAttentionAt: number },
  now: number,
): boolean {
  if (!snooze) return false;
  if (snooze.until !== null) return now < snooze.until;
  return thread.latestAttentionAt <= snooze.attentionAt;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

function dayOffset(from: Date, to: Date): number {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / (24 * HOUR_MS));
}

const timeOf = (date: Date) =>
  date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: date.getMinutes() === 0 ? undefined : "2-digit",
  });

/**
 * When a snooze ends, for menus and tooltips: "until 3:30 PM", "until
 * tomorrow, 9 AM", "until Mon, 9 AM", "until Oct 7, 9 AM", or "until it
 * updates".
 */
export function describeWake(until: number | null, now: number): string {
  if (until === null) return "until it updates";
  const date = new Date(until);
  const today = new Date(now);
  const days = dayOffset(today, date);
  if (sameDay(date, today)) return `until ${timeOf(date)}`;
  if (days === 1) return `until tomorrow, ${timeOf(date)}`;
  if (days > 1 && days < 7)
    return `until ${date.toLocaleDateString(undefined, { weekday: "short" })}, ${timeOf(date)}`;
  return `until ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${timeOf(date)}`;
}

export type SnoozeChoice = {
  readonly id: SnoozePresetId;
  readonly label: string;
  readonly until: number | null;
  /** When it wakes, beside the label: "2:15 PM", "Thu 9 AM"; empty for activity. */
  readonly hint: string;
};

/** Every preset, resolved at `now`, in menu order. */
export function snoozeChoices(now: number): SnoozeChoice[] {
  return SNOOZE_PRESETS.map(({ id, label }) => {
    const until = wakeTime(id, now);
    return { id, label, until, hint: wakeHint(until, now) };
  });
}

function wakeHint(until: number | null, now: number): string {
  if (until === null) return "";
  const date = new Date(until);
  const today = new Date(now);
  if (sameDay(date, today)) return timeOf(date);
  if (dayOffset(today, date) < 7)
    return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${timeOf(date)}`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * A compact wake label for a sidebar row: "3:30 PM" today, a weekday within
 * the week, else a date; "On update" for an activity snooze.
 */
export function shortWake(until: number | null, now: number): string {
  if (until === null) return "On update";
  const date = new Date(until);
  const today = new Date(now);
  if (sameDay(date, today)) return timeOf(date);
  const days = dayOffset(today, date);
  if (days === 1) return "Tomorrow";
  if (days > 1 && days < 7)
    return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
