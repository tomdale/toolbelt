import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNOOZE,
  isSnoozed,
  presetFromSetting,
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
  it("adds hours for the short presets", () => {
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
  it("reads the setting by label or id, falling back to the default", () => {
    expect(presetFromSetting("3 hours")).toBe("3h");
    expect(presetFromSetting("next-week")).toBe("next-week");
    expect(presetFromSetting("someday")).toBe(DEFAULT_SNOOZE);
    expect(presetFromSetting(undefined)).toBe(DEFAULT_SNOOZE);
  });

  it("offers every preset with its wake hint", () => {
    const choices = snoozeChoices(wednesday);
    expect(choices.map((c) => c.id)).toEqual([
      "1h",
      "3h",
      "tomorrow",
      "next-week",
      "activity",
    ]);
    expect(choices.at(-1)!.hint).toBe("");
    expect(choices[2]!.until).toBe(at(2026, 10, 1, 9));
  });

  it("labels rows compactly", () => {
    expect(shortWake(null, wednesday)).toBe("On update");
    expect(shortWake(at(2026, 10, 1, 9), wednesday)).toBe("Tomorrow");
  });
});
