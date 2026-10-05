import { describe, expect, it } from "vitest";
import type { StoredAnalysis } from "../../src/domain/analysis.ts";
import { recapInputSchema, toRecap } from "../../src/domain/recap.ts";
import { isDone, needsYou, workView } from "../../src/domain/status.ts";

const analysis = (
  state: StoredAnalysis["state"],
  revision = 100,
): StoredAnalysis => ({
  recap: "Analysis recap",
  state,
  needsYou: state === "needs_decision" ? "Pick one" : null,
  subject: null,
  goal: "Analysis goal",
  drift: null,
  driftSectionId: null,
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
