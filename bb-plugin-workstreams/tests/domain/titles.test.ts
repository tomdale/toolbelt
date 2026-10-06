import { describe, expect, it } from "vitest";
import {
  observeTitle,
  retitleDecision,
  type TitleRecord,
} from "../../src/domain/titles.ts";

const fresh: TitleRecord = {
  observed: "Old",
  written: null,
  retitledAt: null,
  provisional: false,
};
const thread = {
  title: "Old",
  displayTitle: "Old",
  status: "idle",
  latestAttentionAt: 100,
};
const decide = (
  overrides: Partial<Parameters<typeof retitleDecision>[0]> = {},
) =>
  retitleDecision({
    record: fresh,
    thread,
    suggestion: "New",
    revision: 100,
    basis: "analysis",
    ...overrides,
  });

describe("observeTitle", () => {
  it("records a first title observation", () => {
    expect(observeTitle(undefined, "Generated")).toEqual({
      ...fresh,
      observed: "Generated",
    });
  });
  it("observes external title changes without disabling updates", () => {
    const changed = observeTitle(fresh, "Mine");
    expect(changed.observed).toBe("Mine");
    expect(decide({ record: changed })).toEqual({ ok: true });
  });
  it("clears provisional status when a title is cleared or changed externally", () => {
    const provisional = { ...fresh, written: "Old", provisional: true };
    expect(observeTitle(provisional, "Old")).toBe(provisional);
    expect(observeTitle(provisional, "Mine")).toMatchObject({
      observed: "Mine",
      provisional: false,
    });
    expect(observeTitle(provisional, null)).toMatchObject({
      observed: null,
      provisional: false,
    });
  });
});

describe("retitleDecision", () => {
  it("accepts current suggestions for recently retitled and provisional titles", () => {
    expect(decide()).toEqual({ ok: true });
    for (const provisional of [true, false])
      expect(
        decide({ record: { ...fresh, retitledAt: Date.now(), provisional } }),
      ).toEqual({ ok: true });
  });
  it("declines missing, unchanged, stale and running-turn suggestions", () => {
    expect(decide({ suggestion: null })).toEqual({
      ok: false,
      reason: "no-suggestion",
    });
    expect(decide({ suggestion: " old " })).toEqual({
      ok: false,
      reason: "unchanged",
    });
    expect(decide({ revision: 99 })).toEqual({ ok: false, reason: "stale" });
    expect(decide({ thread: { ...thread, status: "active" } })).toEqual({
      ok: false,
      reason: "stale",
    });
  });
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
  it("names untitled starting or active threads", () => {
    for (const status of ["pending", "starting", "active"])
      expect(opening({ thread: { ...untitled, status } })).toEqual({
        ok: true,
      });
  });
  it("opening analysis never replaces an existing title", () => {
    expect(opening({ thread })).toEqual({ ok: false, reason: "titled" });
    expect(
      opening({
        record: { ...fresh, written: "Old", provisional: true },
        thread,
      }),
    ).toEqual({ ok: false, reason: "titled" });
  });
  it("opening analysis yields to newer turns and empty or unchanged suggestions", () => {
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
});
