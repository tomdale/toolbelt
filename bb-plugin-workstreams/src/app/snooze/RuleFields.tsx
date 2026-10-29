/**
 * The fields that define a snooze, shared by the preset editor in settings
 * and the Custom… dialog, so an ad hoc snooze offers the same choices as a
 * preset. The form edits a draft that keeps every kind's fields, so
 * switching kinds and back loses nothing, and validates it only when read.
 */
import { useEffect, useId, useRef } from "react";
import { Input } from "@/components/ui/input";
import {
  MAX_SNOOZE_AMOUNT,
  MAX_SNOOZE_MS,
  SNOOZE_UNITS,
  WEEKDAYS,
  dayLabel,
  snoozeRuleSchema,
  wakeTime,
  type SnoozeDay,
  type SnoozeRule,
  type SnoozeRuleKind,
  type SnoozeUnit,
} from "../../domain/snooze.ts";
import { SegmentedControl } from "../settings/ui.tsx";

/** A rule kind, or a one-off date and time (Custom… only). */
export type SnoozeDraftKind = SnoozeRuleKind | "date";

export type SnoozeDraft = {
  readonly kind: SnoozeDraftKind;
  /** The duration's amount as typed. */
  readonly amount: string;
  readonly unit: SnoozeUnit;
  readonly day: SnoozeDay;
  /** An `<input type="time">` value, "HH:MM". */
  readonly time: string;
  /** An `<input type="datetime-local">` value. */
  readonly date: string;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** A `datetime-local` value (local time, minutes precision). */
export function toLocalInput(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A draft showing `rule`, or a fresh one of `kind`. Fields the rule doesn't
 * set start on an hour, a time of 9 AM, and a date of tomorrow at 9 AM.
 */
export function draftOf(
  rule: SnoozeRule | undefined,
  now: number,
  kind: SnoozeDraftKind = rule?.kind ?? "duration",
): SnoozeDraft {
  const tomorrow = wakeTime(
    { kind: "time", day: "tomorrow", hour: 9, minute: 0 },
    now,
  )!;
  return {
    kind,
    amount: rule?.kind === "duration" ? String(rule.amount) : "1",
    unit: rule?.kind === "duration" ? rule.unit : "hours",
    day: rule?.kind === "time" ? rule.day : "tomorrow",
    time:
      rule?.kind === "time" ? `${pad(rule.hour)}:${pad(rule.minute)}` : "09:00",
    date: toLocalInput(tomorrow),
  };
}

export type DraftResult =
  | {
      readonly ok: true;
      readonly until: number | null;
      readonly rule?: SnoozeRule;
    }
  | { readonly ok: false; readonly message: string };

const UNIT_LABELS: Readonly<Record<SnoozeUnit, string>> = {
  minutes: "Minutes",
  hours: "Hours",
  days: "Days",
};

/**
 * The rule a draft describes (absent for a date), and when it would wake if
 * chosen at `now`; or why it can't be used yet.
 */
export function resolveDraft(draft: SnoozeDraft, now: number): DraftResult {
  if (draft.kind === "date") {
    const until = draft.date ? new Date(draft.date).getTime() : NaN;
    if (!Number.isFinite(until) || until <= now)
      return { ok: false, message: "Pick a time in the future." };
    if (until > now + MAX_SNOOZE_MS)
      return { ok: false, message: "Pick a time in the next year." };
    return { ok: true, until };
  }
  let candidate: unknown;
  if (draft.kind === "activity") candidate = { kind: "activity" };
  else if (draft.kind === "duration") {
    const amount = /^\d+$/.test(draft.amount.trim())
      ? Number(draft.amount)
      : NaN;
    const max = MAX_SNOOZE_AMOUNT[draft.unit];
    if (!(amount >= 1)) return { ok: false, message: "Enter an amount." };
    if (amount > max)
      return {
        ok: false,
        message: `At most ${max} ${UNIT_LABELS[draft.unit].toLowerCase()}.`,
      };
    candidate = { kind: "duration", amount, unit: draft.unit };
  } else {
    const [hour, minute] = draft.time.split(":").map(Number);
    candidate = { kind: "time", day: draft.day, hour, minute };
  }
  const parsed = snoozeRuleSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, message: "Pick a time." };
  return { ok: true, rule: parsed.data, until: wakeTime(parsed.data, now) };
}

const KIND_LABELS: Readonly<Record<SnoozeDraftKind, string>> = {
  duration: "Duration",
  time: "Time",
  date: "Date",
  activity: "On update",
};

/** Weekdays from Monday, the order a week reads in. */
const WEEK_ORDER = [...WEEKDAYS.slice(1), WEEKDAYS[0]];

const selectClass =
  "flex h-8 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function SnoozeRuleFields({
  draft,
  onChange,
  kinds,
  picker = "segmented",
  autoFocus = false,
}: {
  draft: SnoozeDraft;
  onChange: (draft: SnoozeDraft) => void;
  /** The kinds offered, in order. */
  kinds: readonly SnoozeDraftKind[];
  /**
   * How the kinds are chosen: a segmented control above the chosen kind's
   * fields, or a radio list that shows the chosen kind's fields inline
   * under its radio and hides the rest.
   */
  picker?: "segmented" | "radios";
  /**
   * Focuses the chosen kind's fields. With radios, only on mount: fields
   * that appear when the kind changes leave focus on the radio, so arrow
   * keys keep moving between kinds.
   */
  autoFocus?: boolean;
}) {
  const name = useId();
  const focusOnMount = useRef(autoFocus);
  useEffect(() => {
    focusOnMount.current = false;
  }, []);
  const set = (change: Partial<SnoozeDraft>) =>
    onChange({ ...draft, ...change });
  const fields = (
    <KindFields
      draft={draft}
      set={set}
      autoFocus={picker === "radios" ? focusOnMount.current : autoFocus}
    />
  );
  if (picker === "radios")
    return (
      <div role="radiogroup" aria-label="Snooze kind" className="space-y-2">
        {kinds.map((kind) => (
          <div key={kind} className="space-y-1.5">
            <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name={name}
                value={kind}
                checked={draft.kind === kind}
                onChange={() => set({ kind })}
                className="cursor-pointer accent-foreground"
              />
              {KIND_LABELS[kind]}
            </label>
            {draft.kind === kind && kind !== "activity" ? (
              <div className="pl-6">{fields}</div>
            ) : null}
          </div>
        ))}
      </div>
    );
  return (
    <div className="space-y-2">
      {kinds.length > 1 ? (
        <SegmentedControl
          label="Snooze kind"
          value={draft.kind}
          options={kinds.map((kind) => ({
            value: kind,
            label: KIND_LABELS[kind],
          }))}
          onChange={(kind) => set({ kind })}
        />
      ) : null}
      {fields}
    </div>
  );
}

/** The chosen kind's own fields; Until it updates has none. */
function KindFields({
  draft,
  set,
  autoFocus,
}: {
  draft: SnoozeDraft;
  set: (change: Partial<SnoozeDraft>) => void;
  autoFocus: boolean;
}) {
  return draft.kind === "duration" ? (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        max={MAX_SNOOZE_AMOUNT[draft.unit]}
        step={1}
        autoFocus={autoFocus}
        value={draft.amount}
        onChange={(event) => set({ amount: event.target.value })}
        aria-label="Amount"
        className="h-8 w-20 text-sm"
      />
      <select
        value={draft.unit}
        onChange={(event) => set({ unit: event.target.value as SnoozeUnit })}
        aria-label="Unit"
        className={selectClass}
      >
        {SNOOZE_UNITS.map((unit) => (
          <option key={unit} value={unit}>
            {UNIT_LABELS[unit].toLowerCase()}
          </option>
        ))}
      </select>
    </div>
  ) : draft.kind === "time" ? (
    <div className="flex items-center gap-2">
      <select
        autoFocus={autoFocus}
        value={draft.day}
        onChange={(event) => set({ day: event.target.value as SnoozeDay })}
        aria-label="Day"
        className={selectClass}
      >
        {(["today", "tomorrow", "workday"] as const).map((day) => (
          <option key={day} value={day}>
            {dayLabel(day)}
          </option>
        ))}
        {WEEK_ORDER.map((day) => (
          <option key={day} value={day}>
            {dayLabel(day)}
          </option>
        ))}
      </select>
      <span className="text-sm text-muted-foreground">at</span>
      <Input
        type="time"
        value={draft.time}
        onChange={(event) => set({ time: event.target.value })}
        aria-label="Time of day"
        className="h-8 w-32 text-sm"
      />
    </div>
  ) : draft.kind === "date" ? (
    <Input
      type="datetime-local"
      autoFocus={autoFocus}
      value={draft.date}
      min={toLocalInput(Date.now())}
      max={toLocalInput(Date.now() + MAX_SNOOZE_MS)}
      onChange={(event) => set({ date: event.target.value })}
      aria-label="Wake time"
      className="h-8 text-sm"
    />
  ) : null;
}
