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
import { z } from "zod";

export type ThreadSnooze = {
  /** When the thread wakes; null waits for its next activity instead. */
  readonly until: number | null;
  /** The thread's `latestAttentionAt` when it was snoozed. */
  readonly attentionAt: number;
  readonly at: number;
};

/**
 * Every snooze choice, in menu order. Times are the user's local clock;
 * "morning" is the `morningHour` preference.
 */
export const SNOOZE_PRESETS = [
  { id: "30m", label: "30 minutes" },
  { id: "1h", label: "1 hour" },
  { id: "3h", label: "3 hours" },
  { id: "tomorrow", label: "Tomorrow morning" },
  { id: "weekend", label: "This weekend" },
  { id: "next-week", label: "Next week" },
  { id: "activity", label: "Until it updates" },
] as const;

export type SnoozePresetId = (typeof SNOOZE_PRESETS)[number]["id"];
const PRESET_IDS = SNOOZE_PRESETS.map((p) => p.id) as [
  SnoozePresetId,
  ...SnoozePresetId[],
];

/** The sidebar's hover menu shows at most this many choices. */
export const QUICK_SNOOZE_LIMIT = 4;
export const MORNING_HOURS = { min: 5, max: 12 } as const;

/**
 * How snoozing behaves, chosen in the Snooze settings section: what a click
 * does, which choices the sidebar's hover menu offers, and when morning is.
 * Stored in plugin storage and shared by every client.
 */
export const snoozePrefsSchema = z.object({
  /** What the snooze button does on click. */
  default: z.enum(PRESET_IDS).catch("tomorrow"),
  /** The hover menu's choices, kept in menu order. */
  quick: z
    .array(z.string())
    .catch([])
    .transform((ids) =>
      PRESET_IDS.filter((id) => ids.includes(id)).slice(0, QUICK_SNOOZE_LIMIT),
    ),
  /** The hour (local, 24-hour) that "morning" choices wake at. */
  morningHour: z
    .number()
    .int()
    .catch(9)
    .transform((hour) =>
      Math.min(MORNING_HOURS.max, Math.max(MORNING_HOURS.min, hour)),
    ),
});
export type SnoozePrefs = z.infer<typeof snoozePrefsSchema>;

/**
 * A change from the settings section. Unlike stored preferences, which are
 * repaired as they're read, a bad change is rejected so it can't quietly
 * replace a good value.
 */
export const snoozePrefsPatchSchema = z
  .object({
    default: z.enum(PRESET_IDS),
    quick: z.array(z.enum(PRESET_IDS)).max(QUICK_SNOOZE_LIMIT),
    morningHour: z.number().int().min(MORNING_HOURS.min).max(MORNING_HOURS.max),
  })
  .partial();

export const DEFAULT_SNOOZE_PREFS: SnoozePrefs = {
  default: "tomorrow",
  quick: ["1h", "tomorrow", "next-week", "activity"],
  morningHour: 9,
};

export function parseSnoozePrefs(raw: unknown): SnoozePrefs {
  const value = raw && typeof raw === "object" ? raw : {};
  return snoozePrefsSchema.parse({ ...DEFAULT_SNOOZE_PREFS, ...value });
}

const HOUR_MS = 60 * 60 * 1000;

export function presetLabel(id: SnoozePresetId): string {
  return SNOOZE_PRESETS.find((p) => p.id === id)!.label;
}

/**
 * When a preset chosen at `now` wakes the thread; null waits for activity.
 * Day choices wake at `morningHour` and are never today: This weekend is the
 * coming Saturday, Next week the coming Monday.
 */
export function wakeTime(
  preset: SnoozePresetId,
  now: number,
  morningHour: number = DEFAULT_SNOOZE_PREFS.morningHour,
): number | null {
  if (preset === "activity") return null;
  if (preset === "30m") return now + HOUR_MS / 2;
  if (preset === "1h") return now + HOUR_MS;
  if (preset === "3h") return now + 3 * HOUR_MS;
  const date = new Date(now);
  date.setHours(morningHour, 0, 0, 0);
  const weekday = preset === "weekend" ? 6 : preset === "next-week" ? 1 : null;
  const days = weekday === null ? 1 : (weekday - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + days);
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

/**
 * Presets resolved at `now`, in menu order: all of them, or only `only`
 * (the hover menu's quick choices).
 */
export function snoozeChoices(
  now: number,
  prefs: Pick<SnoozePrefs, "morningHour"> & {
    only?: readonly SnoozePresetId[];
  } = DEFAULT_SNOOZE_PREFS,
): SnoozeChoice[] {
  return SNOOZE_PRESETS.filter(
    ({ id }) => !prefs.only || prefs.only.includes(id),
  ).map(({ id, label }) => {
    const until = wakeTime(id, now, prefs.morningHour);
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
