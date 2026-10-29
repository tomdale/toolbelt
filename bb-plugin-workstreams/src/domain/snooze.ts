/**
 * Thread snoozes: a thread the user put away until later leaves Up Next,
 * Recent, and its workstream group for the sidebar's Snoozed fold, and comes
 * back on its own.
 *
 * A snooze either has a wake time, or waits for the thread's next activity
 * (`until: null`). Time-based snoozes ignore agent activity, so a long run
 * finishing overnight doesn't undo "tomorrow morning". Every snooze ends when
 * the user sends the thread a message (enforced by the server) or unsnoozes it.
 *
 * Snooze menus offer the user's presets: rules such as "2 hours" or "Monday
 * at 9 AM" that resolve to a wake time at the moment one is chosen. Stored
 * snoozes keep only the resolved time, so editing a preset never moves a
 * thread that is already snoozed.
 */
import { z } from "zod";

export type ThreadSnooze = {
  /** When the thread wakes; null waits for its next activity instead. */
  readonly until: number | null;
  /** The thread's `latestAttentionAt` when it was snoozed. */
  readonly attentionAt: number;
  readonly at: number;
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The furthest out a snooze can wake; the server rejects anything later. */
export const MAX_SNOOZE_MS = 366 * DAY_MS;

export const SNOOZE_UNITS = ["minutes", "hours", "days"] as const;
export type SnoozeUnit = (typeof SNOOZE_UNITS)[number];

/** The longest duration of each unit, which keeps it inside the window. */
export const MAX_SNOOZE_AMOUNT: Readonly<Record<SnoozeUnit, number>> = {
  minutes: 999,
  hours: 999,
  days: 365,
};

/** Named in `Date.getDay()` order. */
export const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/**
 * The day a time rule wakes on, judged when it's chosen:
 *
 * - `today`: today, or tomorrow once the time has passed.
 * - `tomorrow`: the next day.
 * - `workday`: the next Monday through Friday after today, so Friday,
 *   Saturday, and Sunday all wake on Monday.
 * - a weekday: the coming one, never today, so Monday on a Monday is a
 *   week out.
 */
export const SNOOZE_DAYS = [
  "today",
  "tomorrow",
  "workday",
  ...WEEKDAYS,
] as const;
export type SnoozeDay = (typeof SNOOZE_DAYS)[number];

/**
 * How a preset picks a wake time: a span from now, a clock time on a chosen
 * day, or the thread's next activity.
 */
export const snoozeRuleSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("duration"),
      amount: z.number().int().min(1),
      unit: z.enum(SNOOZE_UNITS),
    }),
    z.object({
      kind: z.literal("time"),
      day: z.enum(SNOOZE_DAYS),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    }),
    z.object({ kind: z.literal("activity") }),
  ])
  .refine(
    (rule) =>
      rule.kind !== "duration" || rule.amount <= MAX_SNOOZE_AMOUNT[rule.unit],
    { message: "Snoozes can last at most a year." },
  );
export type SnoozeRule = z.infer<typeof snoozeRuleSchema>;
export type SnoozeRuleKind = SnoozeRule["kind"];

export const MAX_SNOOZE_PRESETS = 6;
export const MAX_PRESET_LABEL = 40;

export const snoozePresetSchema = z.object({
  /** Stable across edits and reordering; the default names a preset by it. */
  id: z.string().min(1).max(64),
  /** The menu label; empty labels the preset by its rule (`ruleLabel`). */
  label: z.string().trim().max(MAX_PRESET_LABEL).default(""),
  rule: snoozeRuleSchema,
});
export type SnoozePreset = z.infer<typeof snoozePresetSchema>;

const presetListSchema = z
  .array(snoozePresetSchema)
  .min(1)
  .max(MAX_SNOOZE_PRESETS)
  .refine(
    (presets) => new Set(presets.map((p) => p.id)).size === presets.length,
    {
      message: "Snooze presets need distinct ids.",
    },
  );

/**
 * How snoozing behaves, chosen in the Snooze settings section: the presets
 * every snooze menu lists, in menu order, and the one a click on a snooze
 * button uses. There is always at least one preset, and `default` always
 * names one of them. Stored in plugin storage and shared by every client.
 */
export const snoozePrefsSchema = z.object({
  presets: presetListSchema,
  /** The id of the preset a click on a snooze button uses. */
  default: z.string(),
});
export type SnoozePrefs = z.infer<typeof snoozePrefsSchema>;

/**
 * A change from the settings section, which replaces the whole preset list
 * at once. Unlike stored preferences, which are repaired as they're read, a
 * bad change is rejected so it can't quietly replace a good value.
 */
export const snoozePrefsPatchSchema = z
  .object({ presets: presetListSchema, default: z.string().min(1) })
  .partial();
export type SnoozePrefsPatch = z.infer<typeof snoozePrefsPatchSchema>;

const at = (hour: number, day: SnoozeDay): SnoozeRule => ({
  kind: "time",
  day,
  hour,
  minute: 0,
});

/**
 * The presets snooze menus offered before they were configurable, by the ids
 * those settings stored. Day choices woke at a shared "morning" hour.
 */
const legacyPresets = (morningHour: number) =>
  [
    {
      id: "30m",
      label: "",
      rule: { kind: "duration", amount: 30, unit: "minutes" },
    },
    {
      id: "1h",
      label: "",
      rule: { kind: "duration", amount: 1, unit: "hours" },
    },
    {
      id: "3h",
      label: "",
      rule: { kind: "duration", amount: 3, unit: "hours" },
    },
    {
      id: "tomorrow",
      label: "Tomorrow morning",
      rule: at(morningHour, "tomorrow"),
    },
    { id: "weekend", label: "This weekend", rule: at(morningHour, "saturday") },
    { id: "next-week", label: "Next week", rule: at(morningHour, "monday") },
    { id: "activity", label: "", rule: { kind: "activity" } },
  ] satisfies SnoozePreset[];

const LEGACY_QUICK = ["1h", "tomorrow", "next-week", "activity"];

export const DEFAULT_SNOOZE_PREFS: SnoozePrefs = {
  presets: legacyPresets(9).filter((p) => LEGACY_QUICK.includes(p.id)),
  default: "tomorrow",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Preferences saved before presets were configurable
 * (`{ default, quick, morningHour }`): the hover menu's quick choices plus
 * the click default, in their old menu order, at the morning hour they used.
 */
function fromLegacy(value: Record<string, unknown>) {
  const hour =
    typeof value.morningHour === "number" && Number.isInteger(value.morningHour)
      ? Math.min(12, Math.max(5, value.morningHour))
      : 9;
  const all = legacyPresets(hour);
  const chosen = all.some((preset) => preset.id === value.default)
    ? value.default
    : DEFAULT_SNOOZE_PREFS.default;
  const quick = Array.isArray(value.quick) ? value.quick : LEGACY_QUICK;
  return {
    presets: all.filter(
      (preset) => quick.includes(preset.id) || preset.id === chosen,
    ),
    default: chosen,
  };
}

/** A stored preset's label, cut to fit rather than costing the preset. */
const repairLabel = (candidate: unknown) =>
  isRecord(candidate) && typeof candidate.label === "string"
    ? { ...candidate, label: candidate.label.trim().slice(0, MAX_PRESET_LABEL) }
    : candidate;

/**
 * Reads stored or received preferences, repairing what doesn't fit: labels
 * too long are cut, invalid or duplicate presets are dropped, extras past
 * the limit are cut, an empty list falls back to the defaults, and a default
 * naming no preset falls back to the first. Settings from before presets
 * were configurable become the presets their menus showed.
 */
export function parseSnoozePrefs(raw: unknown): SnoozePrefs {
  const stored = isRecord(raw) ? raw : {};
  const value = Array.isArray(stored.presets) ? stored : fromLegacy(stored);
  const presets: SnoozePreset[] = [];
  for (const candidate of value.presets as unknown[]) {
    const parsed = snoozePresetSchema.safeParse(repairLabel(candidate));
    if (parsed.success && !presets.some((p) => p.id === parsed.data.id))
      presets.push(parsed.data);
  }
  if (!presets.length) return DEFAULT_SNOOZE_PREFS;
  const kept = presets.slice(0, MAX_SNOOZE_PRESETS);
  const chosen = kept.find((p) => p.id === value.default) ?? kept[0]!;
  return { presets: kept, default: chosen.id };
}

/** The preset a click on a snooze button uses. */
export function defaultPreset(prefs: SnoozePrefs): SnoozePreset {
  return prefs.presets.find((p) => p.id === prefs.default) ?? prefs.presets[0]!;
}

/** An id no preset in `presets` uses. */
export function newPresetId(presets: readonly SnoozePreset[]): string {
  for (;;) {
    const id = `p-${Math.random().toString(36).slice(2, 10)}`;
    if (!presets.some((p) => p.id === id)) return id;
  }
}

/** How many days after today a time rule's day falls (see `SNOOZE_DAYS`). */
function daysAhead(day: SnoozeDay, now: Date, laterToday: boolean): number {
  const weekday = now.getDay();
  if (day === "today") return laterToday ? 0 : 1;
  if (day === "tomorrow") return 1;
  if (day === "workday") return weekday === 5 ? 3 : weekday === 6 ? 2 : 1;
  const target = WEEKDAYS.indexOf(day);
  return (target - weekday + 7) % 7 || 7;
}

/**
 * When a rule chosen at `now` wakes the thread, on the user's local clock;
 * null waits for activity. Minutes and hours are elapsed time; days land on
 * the same clock time that many days later.
 */
export function wakeTime(rule: SnoozeRule, now: number): number | null {
  if (rule.kind === "activity") return null;
  if (rule.kind === "duration" && rule.unit !== "days")
    return now + rule.amount * (rule.unit === "minutes" ? MINUTE_MS : HOUR_MS);
  const date = new Date(now);
  if (rule.kind === "duration") {
    date.setDate(date.getDate() + rule.amount);
    return date.getTime();
  }
  date.setHours(rule.hour, rule.minute, 0, 0);
  const days = daysAhead(rule.day, new Date(now), date.getTime() > now);
  date.setDate(date.getDate() + days);
  date.setHours(rule.hour, rule.minute, 0, 0);
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
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

const timeOf = (date: Date) =>
  date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: date.getMinutes() === 0 ? undefined : "2-digit",
  });

/** A clock time for labels: "9 AM", "6:30 PM". */
export const clockLabel = (hour: number, minute: number) =>
  timeOf(new Date(2000, 0, 1, hour, minute));

/** A weekday's full local name; 2023 began on a Sunday. */
const weekdayName = (index: number) =>
  new Date(2023, 0, 1 + index).toLocaleDateString(undefined, {
    weekday: "long",
  });

/** How settings and labels name each day choice. */
export function dayLabel(day: SnoozeDay): string {
  if (day === "today") return "Today";
  if (day === "tomorrow") return "Tomorrow";
  if (day === "workday") return "Next workday";
  return weekdayName(WEEKDAYS.indexOf(day));
}

const UNIT_NAMES: Readonly<Record<SnoozeUnit, [string, string]>> = {
  minutes: ["minute", "minutes"],
  hours: ["hour", "hours"],
  days: ["day", "days"],
};

/**
 * What a rule does, in words: "30 minutes", "Tomorrow at 9 AM", "Monday at
 * 1 PM", "Until it updates". A preset without its own label shows this.
 */
export function ruleLabel(rule: SnoozeRule): string {
  if (rule.kind === "activity") return "Until it updates";
  if (rule.kind === "duration")
    return `${rule.amount} ${UNIT_NAMES[rule.unit][rule.amount === 1 ? 0 : 1]}`;
  return `${dayLabel(rule.day)} at ${clockLabel(rule.hour, rule.minute)}`;
}

export const presetLabel = (preset: SnoozePreset) =>
  preset.label || ruleLabel(preset.rule);

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
  readonly id: string;
  readonly label: string;
  readonly rule: SnoozeRule;
  /** When it wakes if chosen at the `now` it was resolved for. */
  readonly until: number | null;
  /** When it wakes, beside the label: "2:15 PM", "Thu 9 AM"; empty for activity. */
  readonly hint: string;
};

/** The presets resolved at `now`, in menu order. */
export function snoozeChoices(
  presets: readonly SnoozePreset[],
  now: number,
): SnoozeChoice[] {
  return presets.map((preset) => {
    const until = wakeTime(preset.rule, now);
    return {
      id: preset.id,
      label: presetLabel(preset),
      rule: preset.rule,
      until,
      hint: wakeHint(until, now),
    };
  });
}

/** A compact wake time beside a choice: "2:15 PM", "Thu 9 AM", "Oct 7". */
export function wakeHint(until: number | null, now: number): string {
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
