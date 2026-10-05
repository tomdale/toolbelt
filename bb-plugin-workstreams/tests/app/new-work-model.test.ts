import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ComposerSelection,
  NewThreadRequest,
  PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import {
  NewWork,
  identityDisplay,
  shownSuggestion,
  suggestionFrom,
  type IdentityChoice,
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

const request = (text: string): NewThreadRequest => ({
  projectId: "proj_a",
  providerId: "codex",
  model: "gpt-5",
  reasoningLevel: "medium",
  permissionMode: "auto",
  executionInputSources: {},
  environment: { type: "project-default" },
  input: [{ type: "text", text, mentions: [] }],
});

function setup(
  route: (prompt: string) => Promise<RouteDecision>,
  initialIdentity: IdentityChoice = null,
) {
  const deps = {
    route: vi.fn(route),
    cancelRoute: vi.fn(),
    startThread: vi.fn(async () => ({ threadId: "thr_new" })),
    sendToThread: vi.fn(async () => {}),
  } satisfies NewWorkDeps;
  const newWork = new NewWork(deps, initialIdentity);
  const composer = {
    selection: null as ComposerSelection | null,
    submit: vi.fn(async () => {
      await newWork.submit(request(newWork.snapshot().text));
    }),
    setSelection: vi.fn(async (selection: ComposerSelection) => selection),
    focus: vi.fn(),
  };
  newWork.attach(composer as unknown as PluginComposerApi);
  return { deps, newWork, composer };
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

describe("NewWork model: submission contract", () => {
  it("submits new thread with identity and no destination section", async () => {
    const { deps, newWork } = setup(async () => withFeature);
    newWork.observe("Fix billing invoices immediately");
    await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS);

    const req = request("Fix billing invoices immediately");
    const result = await newWork.submit(req);

    expect(result).toEqual({ kind: "started", threadId: "thr_new" });
    expect(deps.startThread).toHaveBeenCalledWith(req, {
      identity: {
        entityId: "ent_billing",
        proposal: null,
        provenance: "automatic",
      },
    });
  });

  it("submits manual unresolved with null identity payload", async () => {
    const { deps, newWork } = setup(async () => withFeature);
    newWork.selectIdentity(null);

    const req = request("Vague task");
    await newWork.submit(req);

    expect(deps.startThread).toHaveBeenCalledWith(req, {
      identity: {
        entityId: null,
        proposal: null,
        provenance: "manual",
      },
    });
  });

  it("sends to existing thread when continuation suggestion is accepted", async () => {
    const { deps, newWork, composer } = setup(async () => continueThread);
    newWork.observe("Carry on with this work");
    await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS);

    await newWork.accept({ submit: true });

    expect(composer.submit).toHaveBeenCalled();
    expect(deps.sendToThread).toHaveBeenCalledWith("thr_p", [
      { type: "text", text: "Carry on with this work", mentions: [] },
    ], "trace_1");
  });
});
