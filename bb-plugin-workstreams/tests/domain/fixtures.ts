import type { WorkstreamThread } from "../../src/domain/project.ts";

export type TestThread = WorkstreamThread & { title: string };

let clock = 1_000_000;

export function thread(
  id: string,
  overrides: Partial<TestThread> = {},
): TestThread {
  clock += 1000;
  return {
    id,
    title: id,
    parentThreadId: null,
    sectionId: null,
    isHidden: false,
    isArchived: false,
    isPinned: false,
    pinSortKey: null,
    hasPendingInteraction: false,
    latestAttentionAt: clock,
    createdAt: clock,
    ...overrides,
  };
}

/** Small deterministic PRNG so generated forests are reproducible. */
export function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
