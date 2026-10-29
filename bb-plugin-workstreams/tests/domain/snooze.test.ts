import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNOOZE_PREFS,
  MAX_SNOOZE_PRESETS,
  isSnoozed,
  parseSnoozePrefs,
  presetLabel,
  ruleLabel,
  shortWake,
  snoozeChoices,
  snoozePrefsPatchSchema,
  snoozeRuleSchema,
  wakeTime,
  type SnoozeDay,
  type SnoozeRule,
} from "../../src/domain/snooze.ts";

// Local-time dates, so the tests hold in any time zone.
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();
// Wednesday, Sept 30, 2026, 2:15 PM.
const wednesday = at(2026, 9, 30, 14, 15);
const time = (day: SnoozeDay, hour: number, minute = 0): SnoozeRule => ({
  kind: "time",
  day,
  hour,
  minute,
});

describe("wakeTime", () => {
  it("adds minutes and hours as elapsed time", () => {
    const minutes = { kind: "duration", amount: 30, unit: "minutes" } as const;
    const hours = { kind: "duration", amount: 3, unit: "hours" } as const;
    expect(wakeTime(minutes, wednesday)).toBe(at(2026, 9, 30, 14, 45));
    expect(wakeTime(hours, wednesday)).toBe(at(2026, 9, 30, 17, 15));
  });

  it("lands days on the same clock time, across a month end", () => {
    const days = { kind: "duration", amount: 2, unit: "days" } as const;
    expect(wakeTime(days, wednesday)).toBe(at(2026, 10, 2, 14, 15));
  });

  it("wakes today until the time passes, then tomorrow", () => {
    expect(wakeTime(time("today", 18), wednesday)).toBe(at(2026, 9, 30, 18));
    expect(wakeTime(time("today", 14, 15), wednesday)).toBe(
      at(2026, 10, 1, 14, 15),
    );
    expect(wakeTime(time("today", 9), wednesday)).toBe(at(2026, 10, 1, 9));
  });

  it("wakes tomorrow at its time, even across a month end", () => {
    expect(wakeTime(time("tomorrow", 9), wednesday)).toBe(at(2026, 10, 1, 9));
    expect(wakeTime(time("tomorrow", 7, 30), wednesday)).toBe(
      at(2026, 10, 1, 7, 30),
    );
  });

  it("wakes on the coming weekday, never today", () => {
    expect(wakeTime(time("monday", 9), wednesday)).toBe(at(2026, 10, 5, 9));
    const monday = at(2026, 10, 5, 8);
    expect(wakeTime(time("monday", 9), monday)).toBe(at(2026, 10, 12, 9));
    const sunday = at(2026, 10, 4, 20);
    expect(wakeTime(time("monday", 9), sunday)).toBe(at(2026, 10, 5, 9));
    expect(wakeTime(time("saturday", 9), wednesday)).toBe(at(2026, 10, 3, 9));
    expect(wakeTime(time("saturday", 9), at(2026, 10, 3, 8))).toBe(
      at(2026, 10, 10, 9),
    );
  });

  it("wakes the next workday, skipping the weekend", () => {
    const workday = time("workday", 9);
    expect(wakeTime(workday, wednesday)).toBe(at(2026, 10, 1, 9));
    expect(wakeTime(workday, at(2026, 10, 2, 8))).toBe(at(2026, 10, 5, 9));
    expect(wakeTime(workday, at(2026, 10, 3, 8))).toBe(at(2026, 10, 5, 9));
    expect(wakeTime(workday, at(2026, 10, 4, 8))).toBe(at(2026, 10, 5, 9));
  });

  it("has no time for an activity snooze", () => {
    expect(wakeTime({ kind: "activity" }, wednesday)).toBeNull();
  });
});

describe("isSnoozed", () => {
  const thread = { latestAttentionAt: 1_000 };

  it("holds a timed snooze until its time, whatever the thread does", () => {
    const snooze = { until: 5_000, attentionAt: 1_000, at: 1_000 };
    expect(isSnoozed(snooze, { latestAttentionAt: 4_000 }, 4_999)).toBe(true);
    expect(isSnoozed(snooze, thread, 5_000)).toBe(false);
  });

  it("holds an activity snooze until the thread has new attention", () => {
    const snooze = { until: null, attentionAt: 1_000, at: 1_000 };
    expect(isSnoozed(snooze, thread, 9_999_999)).toBe(true);
    expect(isSnoozed(snooze, { latestAttentionAt: 1_001 }, 2_000)).toBe(false);
  });

  it("is false with no snooze", () => {
    expect(isSnoozed(undefined, thread, 0)).toBe(false);
  });
});

describe("rules", () => {
  it("keeps durations inside the snooze window", () => {
    const days = (amount: number) =>
      snoozeRuleSchema.safeParse({ kind: "duration", amount, unit: "days" })
        .success;
    expect(days(365)).toBe(true);
    expect(days(366)).toBe(false);
    expect(days(0)).toBe(false);
    expect(snoozeRuleSchema.safeParse({ ...time("today", 24) }).success).toBe(
      false,
    );
  });

  it("labels a rule by what it does", () => {
    expect(ruleLabel({ kind: "duration", amount: 1, unit: "hours" })).toBe(
      "1 hour",
    );
    expect(ruleLabel({ kind: "duration", amount: 30, unit: "minutes" })).toBe(
      "30 minutes",
    );
    expect(ruleLabel(time("tomorrow", 9))).toMatch(/^Tomorrow at 9/);
    expect(ruleLabel(time("workday", 9))).toMatch(/^Next workday at 9/);
    expect(ruleLabel(time("monday", 13, 30))).toMatch(/^Monday at 1:30/);
    expect(ruleLabel({ kind: "activity" })).toBe("Until it updates");
  });

  it("prefers a preset's own label", () => {
    const rule = time("tomorrow", 9);
    expect(presetLabel({ id: "a", label: "Tomorrow morning", rule })).toBe(
      "Tomorrow morning",
    );
    expect(presetLabel({ id: "a", label: "", rule })).toBe(ruleLabel(rule));
  });
});

describe("preferences", () => {
  const preset = (id: string, rule: SnoozeRule = { kind: "activity" }) => ({
    id,
    label: "",
    rule,
  });

  it("starts with the presets the menus always offered", () => {
    expect(parseSnoozePrefs(null)).toEqual(DEFAULT_SNOOZE_PREFS);
    expect(DEFAULT_SNOOZE_PREFS.presets.map((p) => p.id)).toEqual([
      "1h",
      "tomorrow",
      "next-week",
      "activity",
    ]);
    expect(DEFAULT_SNOOZE_PREFS.default).toBe("tomorrow");
  });

  it("repairs stored presets that don't fit", () => {
    const prefs = parseSnoozePrefs({
      presets: [
        preset("a"),
        { id: "bad", label: "", rule: { kind: "someday" } },
        preset("a"),
        ...["b", "c", "d", "e", "f", "g"].map((id) => preset(id)),
      ],
      default: "gone",
    });
    // Invalid and duplicate presets dropped, cut to the limit, and the
    // default moved to the first.
    expect(prefs.presets.map((p) => p.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(prefs.default).toBe("a");
    expect(parseSnoozePrefs({ presets: [], default: "a" })).toEqual(
      DEFAULT_SNOOZE_PREFS,
    );
    // A missing or overlong label is fixed rather than costing the preset.
    expect(
      parseSnoozePrefs({
        presets: [
          { id: "a", rule: { kind: "activity" } },
          { id: "b", label: ` ${"x".repeat(50)}`, rule: { kind: "activity" } },
        ],
        default: "b",
      }),
    ).toEqual({
      presets: [
        { id: "a", label: "", rule: { kind: "activity" } },
        { id: "b", label: "x".repeat(40), rule: { kind: "activity" } },
      ],
      default: "b",
    });
  });

  it("turns settings from before presets into the presets they showed", () => {
    const prefs = parseSnoozePrefs({
      default: "3h",
      quick: ["activity", "weekend"],
      morningHour: 7,
    });
    // The hover menu's choices plus the click default, in the old menu order.
    expect(prefs.presets.map((p) => [p.id, presetLabel(p)])).toEqual([
      ["3h", "3 hours"],
      ["weekend", "This weekend"],
      ["activity", "Until it updates"],
    ]);
    expect(prefs.presets[1]!.rule).toEqual(time("saturday", 7));
    expect(prefs.default).toBe("3h");
    expect(parseSnoozePrefs({ default: "next-week" }).presets).toHaveLength(4);
  });

  it("rejects a change that would leave no presets or too many", () => {
    const list = (n: number) =>
      Array.from({ length: n }, (_, i) => preset(`p${i}`));
    expect(snoozePrefsPatchSchema.safeParse({ presets: [] }).success).toBe(
      false,
    );
    expect(
      snoozePrefsPatchSchema.safeParse({ presets: list(MAX_SNOOZE_PRESETS) })
        .success,
    ).toBe(true);
    expect(
      snoozePrefsPatchSchema.safeParse({
        presets: list(MAX_SNOOZE_PRESETS + 1),
      }).success,
    ).toBe(false);
    expect(
      snoozePrefsPatchSchema.safeParse({ presets: [preset("x"), preset("x")] })
        .success,
    ).toBe(false);
  });

  it("resolves every preset at the moment of choosing, in order", () => {
    const choices = snoozeChoices(DEFAULT_SNOOZE_PREFS.presets, wednesday);
    expect(choices.map((c) => [c.label, c.until])).toEqual([
      ["1 hour", at(2026, 9, 30, 15, 15)],
      ["Tomorrow morning", at(2026, 10, 1, 9)],
      ["Next week", at(2026, 10, 5, 9)],
      ["Until it updates", null],
    ]);
    expect(choices.at(-1)!.hint).toBe("");
  });

  it("labels rows compactly", () => {
    expect(shortWake(null, wednesday)).toBe("On update");
    expect(shortWake(at(2026, 10, 1, 9), wednesday)).toBe("Tomorrow");
  });
});
