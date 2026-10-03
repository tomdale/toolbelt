import { describe, expect, it } from "vitest";
import {
  relativeAge,
  relativeAgeLabel,
} from "../../src/domain/presentation.ts";

const now = 1_000_000_000_000;
const ago = (ms: number) => now - ms;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeAgeLabel", () => {
  it.each([
    [0, "now", "just now"],
    [30_000, "now", "just now"],
    [MINUTE, "1m", "1 minute ago"],
    [5 * MINUTE, "5m", "5 minutes ago"],
    [59 * MINUTE, "59m", "59 minutes ago"],
    [HOUR, "1h", "1 hour ago"],
    [23 * HOUR, "23h", "23 hours ago"],
    [DAY, "1d", "1 day ago"],
    [13 * DAY, "13d", "13 days ago"],
    [14 * DAY, "2w", "2 weeks ago"],
    [60 * DAY, "8w", "8 weeks ago"],
  ])("spells out %i ms as %s", (age, short, long) => {
    expect(relativeAge(ago(age), now)).toBe(short);
    expect(relativeAgeLabel(ago(age), now)).toBe(long);
  });

  it("never reports a future time as negative", () => {
    expect(relativeAgeLabel(now + HOUR, now)).toBe("just now");
  });
});
