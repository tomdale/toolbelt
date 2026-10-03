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
  provisional: false,
};

describe("observeTitle", () => {
  it("trusts a first observation, including a titled thread", () => {
    expect(observeTitle(undefined, "Generated")).toEqual({
      observed: "Generated",
      written: null,
      locked: false,
      retitledAt: null,
      provisional: false,
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

  it("keeps a provisional title provisional until someone else changes it", () => {
    const provisional = {
      ...fresh,
      observed: "Ours",
      written: "Ours",
      provisional: true,
    };
    expect(observeTitle(provisional, "Ours")).toBe(provisional);
    expect(observeTitle(provisional, "Mine")).toMatchObject({
      locked: true,
      provisional: false,
    });
    expect(observeTitle(provisional, null)).toMatchObject({
      locked: false,
      provisional: false,
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
      basis: "analysis",
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

  describe("a provisional title", () => {
    const provisional: TitleRecord = {
      observed: "Old",
      written: "Old",
      locked: false,
      retitledAt: 10 * RETITLE_COOLDOWN_MS - 60_000,
      provisional: true,
    };

    it("is replaced by the first full analysis whatever the cooldown says", () => {
      expect(
        decide({ record: { ...provisional, provisional: false } }),
      ).toEqual({ ok: false, reason: "cooldown" });
      expect(decide({ record: provisional })).toEqual({ ok: true });
    });

    it("still yields to a lock and to a newer or running turn", () => {
      expect(
        decide({ record: { ...provisional, locked: true } }),
      ).toMatchObject({ reason: "locked" });
      expect(
        decide({
          record: provisional,
          thread: { ...thread, status: "active" },
        }),
      ).toMatchObject({ reason: "stale" });
      expect(decide({ record: provisional, revision: 99 })).toMatchObject({
        reason: "stale",
      });
    });

    it("is kept when the new goal is the same", () => {
      expect(decide({ record: provisional, suggestion: "OLD" })).toMatchObject({
        reason: "unchanged",
      });
    });
  });

  describe("naming a thread from its opening request", () => {
    const untitled = {
      title: null,
      displayTitle: "fix the cache thing…",
      status: "active",
      latestAttentionAt: 100,
    };
    const opening = (
      overrides: Partial<Parameters<typeof retitleDecision>[0]> = {},
    ) =>
      decide({
        basis: "opening",
        record: { ...fresh, observed: null },
        thread: untitled,
        ...overrides,
      });

    it("names an untitled thread while its first turn is still running", () => {
      expect(opening()).toEqual({ ok: true });
      for (const status of ["pending", "starting", "active"])
        expect(opening({ thread: { ...untitled, status } })).toEqual({
          ok: true,
        });
    });

    it("never replaces a title the thread has, whoever wrote it", () => {
      expect(
        opening({
          thread: { ...untitled, title: "Fix stale build cache" },
        }),
      ).toEqual({ ok: false, reason: "titled" });
      expect(
        opening({
          record: { ...fresh, written: "Old", provisional: true },
          thread: { ...untitled, title: "Old", displayTitle: "Old" },
        }),
      ).toEqual({ ok: false, reason: "titled" });
    });

    it("yields to a lock, a finished turn, and an empty or unchanged goal", () => {
      expect(
        opening({ record: { ...fresh, observed: null, locked: true } }),
      ).toEqual({ ok: false, reason: "locked" });
      // The turn finished while the call ran; its analysis names the thread.
      expect(
        opening({ thread: { ...untitled, latestAttentionAt: 101 } }),
      ).toEqual({ ok: false, reason: "stale" });
      expect(opening({ suggestion: null })).toEqual({
        ok: false,
        reason: "no-suggestion",
      });
      expect(opening({ suggestion: "Fix the cache thing…" })).toEqual({
        ok: false,
        reason: "unchanged",
      });
    });

    it("isn't held to the cooldown or to the thread being idle", () => {
      const recent = {
        ...fresh,
        observed: null,
        retitledAt: 10 * RETITLE_COOLDOWN_MS - 1,
      };
      expect(opening({ record: recent })).toEqual({ ok: true });
    });
  });
});
