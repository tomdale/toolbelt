import { describe, expect, it } from "vitest";
import {
  RETITLE_COOLDOWN_MS,
  observeTitle,
  retitleDecision,
  type TitleRecord,
} from "../../src/domain/titles.ts";

const fresh: TitleRecord = {
  observed: "Old",
  written: null,
  locked: false,
  retitledAt: null,
};

describe("observeTitle", () => {
  it("trusts a first observation, including a titled thread", () => {
    expect(observeTitle(undefined, "Generated")).toEqual({
      observed: "Generated",
      written: null,
      locked: false,
      retitledAt: null,
    });
  });

  it("treats BB filling an empty title as its own, not a rename", () => {
    const untitled = observeTitle(undefined, null);
    expect(observeTitle(untitled, "Generated").locked).toBe(false);
  });

  it("locks when a title changes to one Workstreams didn't write", () => {
    expect(observeTitle(fresh, "Mine").locked).toBe(true);
    const ours = { ...fresh, written: "Ours" };
    expect(observeTitle(ours, "Ours").locked).toBe(false);
  });

  it("unlocks when the title is cleared", () => {
    const locked = { ...fresh, locked: true };
    expect(observeTitle(locked, null)).toMatchObject({
      observed: null,
      locked: false,
    });
  });
});

describe("retitleDecision", () => {
  const thread = {
    title: "Old",
    displayTitle: "Old",
    status: "idle",
    latestAttentionAt: 100,
  };
  const decide = (overrides: Partial<Parameters<typeof retitleDecision>[0]>) =>
    retitleDecision({
      record: fresh,
      thread,
      suggestion: "New",
      revision: 100,
      now: 10 * RETITLE_COOLDOWN_MS,
      ...overrides,
    });

  it("accepts a suggestion for the current turn", () => {
    expect(decide({})).toEqual({ ok: true });
  });

  it("declines a missing, unchanged, stale, or locked suggestion", () => {
    expect(decide({ suggestion: null })).toMatchObject({
      reason: "no-suggestion",
    });
    expect(decide({ suggestion: " old " })).toMatchObject({
      reason: "unchanged",
    });
    expect(decide({ revision: 99 })).toMatchObject({ reason: "stale" });
    expect(decide({ thread: { ...thread, status: "active" } })).toMatchObject({
      reason: "stale",
    });
    expect(decide({ record: { ...fresh, locked: true } })).toMatchObject({
      reason: "locked",
    });
  });

  it("rate-limits titled threads but not untitled ones", () => {
    const recent = { ...fresh, retitledAt: 10 * RETITLE_COOLDOWN_MS - 1 };
    expect(decide({ record: recent })).toMatchObject({ reason: "cooldown" });
    expect(
      decide({
        record: { ...recent, observed: null },
        thread: { ...thread, title: null, displayTitle: "fix the…" },
      }),
    ).toEqual({ ok: true });
  });
});
