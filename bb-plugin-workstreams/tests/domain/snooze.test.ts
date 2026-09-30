import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNOOZE_PREFS,
  isSnoozed,
  parseSnoozePrefs,
  shortWake,
  snoozeChoices,
  wakeTime,
} from "../../src/domain/snooze.ts";

// Local-time dates, so the tests hold in any time zone.
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();
// Wednesday, Sept 30, 2026, 2:15 PM.
const wednesday = at(2026, 9, 30, 14, 15);

describe("wakeTime", () => {
  it("adds minutes and hours for the short presets", () => {
    expect(wakeTime("30m", wednesday)).toBe(at(2026, 9, 30, 14, 45));
    expect(wakeTime("1h", wednesday)).toBe(at(2026, 9, 30, 15, 15));
    expect(wakeTime("3h", wednesday)).toBe(at(2026, 9, 30, 17, 15));
  });

  it("wakes tomorrow morning at 9, even across a month end", () => {
    expect(wakeTime("tomorrow", wednesday)).toBe(at(2026, 10, 1, 9));
  });

  it("wakes next week on the coming Monday morning, never today", () => {
    expect(wakeTime("next-week", wednesday)).toBe(at(2026, 10, 5, 9));
    const monday = at(2026, 10, 5, 8);
    expect(wakeTime("next-week", monday)).toBe(at(2026, 10, 12, 9));
    const sunday = at(2026, 10, 4, 20);
    expect(wakeTime("next-week", sunday)).toBe(at(2026, 10, 5, 9));
  });

  it("wakes this weekend on the coming Saturday morning, never today", () => {
    expect(wakeTime("weekend", wednesday)).toBe(at(2026, 10, 3, 9));
    expect(wakeTime("weekend", at(2026, 10, 3, 8))).toBe(at(2026, 10, 10, 9));
  });

  it("wakes day choices at the chosen morning hour", () => {
    expect(wakeTime("tomorrow", wednesday, 7)).toBe(at(2026, 10, 1, 7));
    expect(wakeTime("next-week", wednesday, 11)).toBe(at(2026, 10, 5, 11));
  });

  it("has no time for an activity snooze", () => {
    expect(wakeTime("activity", wednesday)).toBeNull();
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

describe("settings and labels", () => {
  it("reads stored preferences, repairing what doesn't fit", () => {
    expect(parseSnoozePrefs(null)).toEqual(DEFAULT_SNOOZE_PREFS);
    expect(
      parseSnoozePrefs({
        default: "someday",
        quick: ["activity", "30m", "nope", "1h", "3h", "tomorrow"],
        morningHour: 3,
      }),
    ).toEqual({
      default: "tomorrow",
      // Menu order, unknown ids dropped, at most four.
      quick: ["30m", "1h", "3h", "tomorrow"],
      morningHour: 5,
    });
  });

  it("offers every preset with its wake hint", () => {
    const choices = snoozeChoices(wednesday);
    expect(choices.map((c) => c.id)).toEqual([
      "30m",
      "1h",
      "3h",
      "tomorrow",
      "weekend",
      "next-week",
      "activity",
    ]);
    expect(choices.at(-1)!.hint).toBe("");
    expect(choices[3]!.until).toBe(at(2026, 10, 1, 9));
    const quick = snoozeChoices(wednesday, {
      morningHour: 8,
      only: ["activity", "tomorrow"],
    });
    expect(quick.map((c) => [c.id, c.until])).toEqual([
      ["tomorrow", at(2026, 10, 1, 8)],
      ["activity", null],
    ]);
  });

  it("labels rows compactly", () => {
    expect(shortWake(null, wednesday)).toBe("On update");
    expect(shortWake(at(2026, 10, 1, 9), wednesday)).toBe("Tomorrow");
  });
});
