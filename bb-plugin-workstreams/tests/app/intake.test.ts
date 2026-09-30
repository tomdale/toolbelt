import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Intake } from "../../src/app/composer/intake.ts";
import { DEBOUNCE_MS, SHORT_PAUSE_MS } from "../../src/app/composer/timing.ts";
import type { RouteDecision } from "../../src/server/router.ts";

const prompt = "Fix the parser";
const decision: RouteDecision = {
  id: "d1",
  outcome: "new-thread",
  sectionId: "sec_a",
  workstream: "Alpha",
  title: "Fix parser",
  confidence: "high",
  reason: "",
  subject: null,
  traceId: null,
  placement: {
    projectId: "proj_a",
    environment: { type: "project-default" },
    label: "checkout",
  },
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("routes a short draft once typing pauses, without treating the initial project as a choice", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, null, null);
  intake.observe(prompt, "proj_unrelated");
  await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS - 1);
  expect(route).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(route).toHaveBeenCalledWith({
    prompt,
    workstreamId: null,
    pickedProjectId: null,
  });
  expect(await intake.forSubmit(prompt)).toEqual({ decision, choice: null });
});

it("keeps an explicit workstream when the draft changes and submits without a second review", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, "sec_a", "Alpha");
  intake.observe(prompt, "proj_unrelated");
  expect(await intake.forSubmit(prompt)).toEqual({ decision, choice: null });
  intake.selectWorkstream("sec_b", "Beta");
  intake.observe("Fix another parser", "proj_unrelated");
  await vi.runAllTimersAsync();
  expect(route).toHaveBeenLastCalledWith({
    prompt: "Fix another parser",
    workstreamId: "sec_b",
    pickedProjectId: null,
  });
});

it("keeps a manual project override through subsequent automatic presets and edits", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, null, null);
  intake.observe(prompt, "proj_unrelated");
  await vi.runAllTimersAsync();
  intake.presetProject("proj_a");
  intake.observe(prompt, "proj_a");
  intake.customizePlacement = true;
  intake.observe(prompt, "proj_mine");
  await vi.runAllTimersAsync();
  intake.presetProject("proj_mine");
  intake.observe("Fix another parser", "proj_mine");
  await vi.runAllTimersAsync();
  expect(route).toHaveBeenLastCalledWith({
    prompt: "Fix another parser",
    workstreamId: null,
    pickedProjectId: "proj_mine",
  });
});

it("requires review in the same composer when a global submit outruns the preview", async () => {
  const intake = new Intake(vi.fn().mockResolvedValue(decision), null, null);
  await expect(intake.forSubmit(prompt)).rejects.toThrow(
    "Review the destination",
  );
  expect(intake.snapshot().decision).toEqual(decision);
  expect(await intake.forSubmit(prompt)).toEqual({ decision, choice: null });
});

it("ignores a late result after the draft is cleared or replaced", async () => {
  let finish!: (decision: RouteDecision) => void;
  const route = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const intake = new Intake(route, null, null);
  intake.observe(prompt, null);
  await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS);
  intake.observe("", null);
  finish(decision);
  await Promise.resolve();
  expect(intake.snapshot()).toMatchObject({
    text: "",
    decision: null,
    loading: false,
  });
});

it("routes a long draft on a short debounce and cancels the call in flight when it changes", async () => {
  const long = "Fix the Alpha parser so it handles tab characters";
  const route = vi.fn().mockReturnValue(new Promise<RouteDecision>(() => {}));
  const cancel = vi.fn();
  const intake = new Intake(route, null, null, cancel);
  intake.observe(long, null);
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  expect(route).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
  intake.observe(`${long} and`, null);
  expect(cancel).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  expect(route).toHaveBeenCalledTimes(2);
  expect(route).toHaveBeenLastCalledWith(
    expect.objectContaining({ prompt: `${long} and` }),
  );
  intake.dispose();
});

it("does not execute a stale result when text changes during a pending submit", async () => {
  let finish!: (decision: RouteDecision) => void;
  const intake = new Intake(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    "sec_a",
    "Alpha",
  );
  const submit = intake.forSubmit(prompt);
  const rejected = expect(submit).rejects.toThrow("draft changed");
  intake.observe("A different request", null);
  finish(decision);
  await rejected;
  intake.dispose();
});

it("keeps an ambiguous route editable until a destination is chosen", async () => {
  const unsure: RouteDecision = {
    id: "d2",
    outcome: "unsure",
    confidence: "low",
    reason: "",
    subject: null,
    traceId: null,
    candidates: [{ kind: "thread", threadId: "thr_a", title: "Parser" }],
  };
  const intake = new Intake(vi.fn().mockResolvedValue(unsure), null, null);
  intake.observe(prompt, null);
  await vi.runAllTimersAsync();
  await expect(intake.forSubmit(prompt)).rejects.toThrow("Choose where");
  intake.selectThread("thr_a");
  expect(await intake.forSubmit(prompt)).toEqual({
    decision: unsure,
    choice: { threadId: "thr_a" },
  });
});

it("resumes routing after a subscription remount cancels the debounce", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, null, null);
  intake.observe(prompt, null);
  intake.dispose();
  intake.observe(prompt, null);
  await vi.runAllTimersAsync();
  expect(intake.snapshot().decision).toEqual(decision);
});

it("accepts returning to the initial project after an automatic preset", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, null, null);
  intake.observe(prompt, "proj_initial");
  await vi.runAllTimersAsync();
  intake.presetProject("proj_a");
  intake.observe(prompt, "proj_a");
  intake.customizePlacement = true;
  intake.observe(prompt, "proj_initial");
  await vi.runAllTimersAsync();
  expect(route).toHaveBeenLastCalledWith({
    prompt,
    workstreamId: null,
    pickedProjectId: "proj_initial",
  });
});

it("presets a changed workstream environment even when the project stays the same", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, "sec_a", "Alpha");
  intake.observe(prompt, "proj_a");
  await vi.runAllTimersAsync();
  if (decision.outcome !== "new-thread") throw new Error("fixture");
  expect(intake.shouldPreset(decision.id, decision.placement)).toBe(true);
  expect(intake.shouldPreset(decision.id, decision.placement)).toBe(false);
  const next: RouteDecision = {
    ...decision,
    id: "d2",
    sectionId: "sec_b",
    placement: {
      ...decision.placement,
      environment: { type: "reuse", environmentId: "env_worktree" },
    },
  };
  route.mockResolvedValue(next);
  intake.selectWorkstream("sec_b", "Beta");
  await vi.runAllTimersAsync();
  expect(intake.shouldPreset(next.id, next.placement)).toBe(true);
});
