import { describe, expect, it } from "vitest";
import type { StoredAnalysis } from "../../src/domain/analysis.ts";
import { recapInputSchema, toRecap } from "../../src/domain/recap.ts";
import {
  isDone,
  needsYou,
  needsAttention,
  upNextKind,
  workView,
} from "../../src/domain/status.ts";

const analysis = (
  state: StoredAnalysis["state"],
  revision = 100,
): StoredAnalysis => ({
  recap: "Analysis recap",
  state,
  needsYou: state === "needs_decision" ? "Pick one" : null,
  goal: "Analysis goal",
  revision,
  at: revision,
  model: "test",
});

const recap = (state: "complete" | "review" | "waiting") =>
  toRecap(
    recapInputSchema.parse({
      state,
      goal: "Reported goal",
      latest: state === "waiting" ? [] : ["Reported result"],
      ...(state === "review" ? { review: "Check it" } : {}),
      ...(state === "waiting" ? { timeout: 60 } : {}),
    }),
    { id: "r1", turnId: "turn-1", at: 100 },
  );

const idle = { status: "idle", latestAttentionAt: 100 };

describe("workView", () => {
  it("prefers the agent's recap over analysis for an idle thread", () => {
    const view = workView(idle, analysis("in_progress"), recap("complete"));
    expect(view).toMatchObject({ kind: "current", reported: true });
    expect(isDone(view)).toBe(true);
    // Analysis still supplies the goal.
    expect(view.kind === "current" && view.analysis.goal).toBe("Analysis goal");
  });

  it("falls back to analysis when the agent didn't report", () => {
    const view = workView(idle, analysis("done"));
    expect(view).toMatchObject({ kind: "current", reported: false });
    expect(isDone(view)).toBe(true);
  });

  it("treats a waiting recap as not done", () => {
    expect(isDone(workView(idle, analysis("done"), recap("waiting")))).toBe(
      false,
    );
  });

  it("ignores the recap while a turn runs, and stale analysis is pending", () => {
    const running = { status: "active", latestAttentionAt: 200 };
    const view = workView(running, analysis("done"), recap("complete"));
    expect(view.kind).toBe("pending");
    expect(isDone(view)).toBe(false);
  });

  it("shows nothing for a failed turn", () => {
    const failed = { status: "error", latestAttentionAt: 100 };
    expect(workView(failed, analysis("done"), recap("complete"))).toEqual({
      kind: "none",
    });
  });
});

describe("needsAttention", () => {
  it.each(["done", "review"] as const)(
    "surfaces unread %s turns without treating them as decisions",
    (state) => {
      const thread = { ...idle, hasPendingInteraction: false, isUnread: true };
      const work = workView(thread, analysis(state));
      expect(needsAttention(thread, work)).toBe(true);
      expect(needsYou(thread, work)).toBe(false);
      expect(needsAttention({ ...thread, isUnread: false }, work)).toBe(false);
      expect(
        needsAttention(
          thread,
          workView({ ...thread, status: "active" }, analysis(state)),
        ),
      ).toBe(false);
    },
  );
});

describe("needsYou", () => {
  it("is a pending interaction or a current needs-decision result", () => {
    const quiet = { hasPendingInteraction: false };
    expect(needsYou(quiet, workView(idle, analysis("needs_decision")))).toBe(
      true,
    );
    expect(needsYou(quiet, workView(idle, analysis("in_progress")))).toBe(
      false,
    );
    expect(
      needsYou(
        { hasPendingInteraction: true },
        workView(idle, analysis("in_progress")),
      ),
    ).toBe(true);
  });

  it("clears an inferred ask once the agent reports the turn", () => {
    const view = workView(idle, analysis("needs_decision"), recap("review"));
    expect(needsYou({ hasPendingInteraction: false }, view)).toBe(false);
  });
});

describe("upNextKind", () => {
  const quiet = { hasPendingInteraction: false };
  const asking = { hasPendingInteraction: true };

  it("is a question for a pending interaction or a needed decision", () => {
    expect(upNextKind(asking, workView(idle, analysis("review")))).toBe(
      "question",
    );
    expect(upNextKind(quiet, workView(idle, analysis("needs_decision")))).toBe(
      "question",
    );
  });

  it("is a review for a reported or inferred review", () => {
    expect(upNextKind(quiet, workView(idle, undefined, recap("review")))).toBe(
      "review",
    );
    expect(upNextKind(quiet, workView(idle, analysis("review")))).toBe(
      "review",
    );
  });

  it("is waiting for a reported Waiting or inferred in-progress turn", () => {
    expect(upNextKind(quiet, workView(idle, undefined, recap("waiting")))).toBe(
      "waiting",
    );
    expect(upNextKind(quiet, workView(idle, analysis("in_progress")))).toBe(
      "waiting",
    );
  });

  it("is other for done, blocked, stale, and failed turns", () => {
    expect(
      upNextKind(quiet, workView(idle, undefined, recap("complete"))),
    ).toBe("other");
    expect(upNextKind(quiet, workView(idle, analysis("blocked")))).toBe(
      "other",
    );
    expect(
      upNextKind(
        quiet,
        workView(
          { status: "active", latestAttentionAt: 200 },
          analysis("review"),
        ),
      ),
    ).toBe("other");
    expect(
      upNextKind(
        quiet,
        workView(
          { status: "error", latestAttentionAt: 100 },
          analysis("review"),
        ),
      ),
    ).toBe("other");
  });
});
