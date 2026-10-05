import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NewWork,
  identityDisplay,
  shownSuggestion,
  suggestionFrom,
  type NewWorkDeps,
} from "../../src/app/composer/new-work.ts";
import type { RouteDecision } from "../../src/server/router.ts";
import { DEBOUNCE_MS, SHORT_PAUSE_MS } from "../../src/app/composer/timing.ts";

const base = {
  confidence: "high" as const,
  reason: "Fits feature",
  subject: "Billing",
  subjectId: "ent_billing",
  traceId: "trace_1",
};

const withFeature: RouteDecision = {
  ...base,
  id: "d_feature",
  outcome: "new-thread",
  sectionId: null,
  workstream: null,
  title: "",
  placement: null,
};

const withProposal: RouteDecision = {
  ...base,
  id: "d_proposal",
  outcome: "new-thread",
  sectionId: null,
  workstream: null,
  subject: "Export",
  subjectId: null,
  proposal: { name: "Export", description: "CSV export" },
  title: "",
  placement: null,
};

const continueThread: RouteDecision = {
  ...base,
  id: "d_thread",
  outcome: "continue",
  threadId: "thr_p",
  threadTitle: "Parser fix",
  workstream: "Alpha",
  sectionId: "sec_a",
};

function setup(route: (prompt: string) => Promise<RouteDecision>) {
  const deps = {
    route: vi.fn(route),
    cancelRoute: vi.fn(),
    sendDraftToThread: vi.fn(async () => {}),
  } satisfies NewWorkDeps;
  const newWork = new NewWork(deps);
  return { deps, newWork };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("NewWork model: draft identity purity and automatic suggestion", () => {
  it("classifies draft text after typing pauses", async () => {
    const { deps, newWork } = setup(async () => withFeature);
    newWork.observe("Fix invoice billing layout");

    expect(deps.route).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS);
    expect(deps.route).toHaveBeenCalledWith("Fix invoice billing layout", null);

    const snapshot = newWork.snapshot();
    expect(snapshot.identity).toEqual({
      entityId: "ent_billing",
      proposal: null,
      label: "Billing",
      provenance: "automatic",
    });
    expect(snapshot.suggestion).toBeNull(); // No destination suggestion; identity only
  });

  it("suggests thread continuation when route outcome is continue", async () => {
    const { deps, newWork } = setup(async () => continueThread);
    newWork.observe("Carry on with parser");
    await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS);

    const snapshot = newWork.snapshot();
    expect(snapshot.suggestion).toMatchObject({
      kind: "thread",
      threadId: "thr_p",
      title: "Parser fix",
    });
    expect(shownSuggestion(snapshot)).not.toBeNull();
  });

  it("aborts classification in flight when text changes", async () => {
    let resolveRoute!: () => void;
    const pendingRoute = new Promise<RouteDecision>((resolve) => {
      resolveRoute = () => resolve(withFeature);
    });
    const { deps, newWork } = setup(() => pendingRoute);
    newWork.observe("First draft text here");
    await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS);

    newWork.observe("Updated draft text");
    expect(deps.cancelRoute).toHaveBeenCalledTimes(1);
    resolveRoute();
  });

  it("clears automatic identity when draft text is emptied", async () => {
    const { newWork } = setup(async () => withFeature);
    newWork.observe("Invoice bug in billing layout");
    await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS);
    expect(newWork.snapshot().identity?.entityId).toBe("ent_billing");

    newWork.observe("");
    expect(newWork.snapshot().identity).toBeNull();
  });
});

describe("NewWork model: manual identity selection and manual unresolved", () => {
  it("preserves manual identity when typing further", async () => {
    const { newWork } = setup(async () => withFeature);
    newWork.selectIdentity({ entityId: "ent_storage", label: "Storage" });
    expect(newWork.snapshot().identity).toEqual({
      entityId: "ent_storage",
      proposal: null,
      label: "Storage",
      provenance: "manual",
    });
    expect(identityDisplay(newWork.snapshot())).toMatchObject({
      label: "Storage",
      auto: false,
      selected: true,
    });

    newWork.observe("Some text about invoices");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // Manual identity persists and is not overwritten by classifier
    expect(newWork.snapshot().identity).toEqual({
      entityId: "ent_storage",
      proposal: null,
      label: "Storage",
      provenance: "manual",
    });
  });

  it("persists manual unresolved identity", async () => {
    const { newWork } = setup(async () => withFeature);
    newWork.selectIdentity(null);
    expect(newWork.snapshot().identity).toEqual({
      entityId: null,
      proposal: null,
      label: "Unresolved",
      provenance: "manual",
    });

    newWork.observe("Some other request");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // Manual unresolved persists
    expect(newWork.snapshot().identity).toEqual({
      entityId: null,
      proposal: null,
      label: "Unresolved",
      provenance: "manual",
    });
  });

  it("allows resetting back to automatic identity", async () => {
    const { newWork } = setup(async () => withProposal);
    newWork.observe("Export data to csv file format");
    await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS);

    // Overwrite manually
    newWork.selectIdentity({ entityId: "ent_storage", label: "Storage" });
    expect(newWork.snapshot().identity?.provenance).toBe("manual");

    // Reset to automatic
    newWork.selectAutomaticIdentity();
    expect(newWork.snapshot().identity).toEqual({
      entityId: null,
      proposal: { name: "Export", description: "CSV export" },
      label: "Export",
      provenance: "automatic",
    });
  });
});

describe("NewWork model: Send to", () => {
  it("sends the draft to the suggested thread once", async () => {
    const { deps, newWork } = setup(async () => continueThread);
    newWork.observe("Carry on with this work");
    await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS);

    await newWork.accept();

    expect(deps.sendDraftToThread).toHaveBeenCalledWith("thr_p", "trace_1");
    expect(shownSuggestion(newWork.snapshot())).toBeNull();
    await newWork.accept();
    expect(deps.sendDraftToThread).toHaveBeenCalledTimes(1);
  });

  it("keeps the suggestion and reports a failed send", async () => {
    const { deps, newWork } = setup(async () => continueThread);
    deps.sendDraftToThread.mockRejectedValueOnce(new Error("send failed"));
    newWork.observe("Carry on with this work");
    await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS);

    await newWork.accept();

    expect(newWork.snapshot().error).toBe("send failed");
    expect(shownSuggestion(newWork.snapshot())).not.toBeNull();
  });
});
