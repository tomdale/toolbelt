import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ComposerSelection,
  NewThreadRequest,
  PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import {
  NewWork,
  pickerDisplay,
  shownSuggestion,
  suggestionFrom,
  type NewWorkDeps,
  type WorkstreamChoice,
} from "../../src/app/composer/new-work.ts";
import type { RouteDecision } from "../../src/server/router.ts";
import { DEBOUNCE_MS, SHORT_PAUSE_MS } from "../../src/app/composer/timing.ts";

const base = {
  confidence: "high" as const,
  reason: "Fits",
  subject: null,
  traceId: "trace_1",
};
const placement = {
  projectId: "proj_a",
  environment: {
    type: "host" as const,
    hostId: "host_1",
    workspace: { type: "unmanaged" as const, path: null },
  },
  label: "checkout",
};
const inAlpha: RouteDecision = {
  ...base,
  id: "d_alpha",
  outcome: "new-thread",
  sectionId: "sec_a",
  workstream: "Alpha",
  title: "",
  placement,
};
const continueParser: RouteDecision = {
  ...base,
  id: "d_thread",
  outcome: "continue",
  threadId: "thr_p",
  threadTitle: "Parser fix",
  workstream: "Alpha",
  sectionId: "sec_a",
};
const newBilling: RouteDecision = {
  ...base,
  id: "d_new",
  outcome: "new-workstream",
  name: "Billing",
  description: "Invoices",
  title: "",
  placement,
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
  workstream: WorkstreamChoice = null,
) {
  const deps = {
    route: vi.fn(route),
    cancelRoute: vi.fn(),
    createWorkstream: vi.fn(async (name: string) => ({
      sectionId: "sec_new",
      name,
    })),
    startThread: vi.fn(async () => ({ threadId: "thr_new" })),
    sendToThread: vi.fn(async () => {}),
  } satisfies NewWorkDeps;
  const newWork = new NewWork(deps, workstream);
  const composer = {
    selection: null as ComposerSelection | null,
    submit: vi.fn(async () => {
      // BB's composer calls the dialog's onSubmit with its request.
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

async function pause(ms = SHORT_PAUSE_MS) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("classification", () => {
  it("runs once typing pauses and moves the pickers to its suggestion", async () => {
    const { deps, newWork, composer } = setup(async () => inAlpha);
    newWork.observe("Fix");
    newWork.observe("Fix the");
    await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS - 1);
    expect(deps.route).not.toHaveBeenCalled();
    await pause(1);
    expect(deps.route).toHaveBeenCalledExactlyOnceWith("Fix the", null);
    expect(newWork.snapshot()).toMatchObject({
      pinned: false,
      workstream: { id: "sec_a", name: "Alpha" },
    });
    expect(composer.setSelection).toHaveBeenCalledExactlyOnceWith({
      projectId: "proj_a",
      environment: placement.environment,
    });
    // The row's own offer is hidden: the pickers already show it.
    expect(shownSuggestion(newWork.snapshot())).toBeNull();
  });

  it("tells the router which workstream the field shows", async () => {
    const { deps, newWork } = setup(async () => inAlpha, {
      id: "sec_b",
      name: "Beta",
    });
    newWork.observe("Fix the parser in Beta");
    await pause(DEBOUNCE_MS);
    expect(deps.route).toHaveBeenLastCalledWith(
      "Fix the parser in Beta",
      "sec_b",
    );
    newWork.selectWorkstream({ id: "sec_a", name: "Alpha" });
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    expect(deps.route).toHaveBeenLastCalledWith(
      "Fix the parser in Alpha",
      "sec_a",
    );
  });

  it("keeps the last destination up while newer text is classified", async () => {
    let answer: (d: RouteDecision) => void = () => {};
    const { deps, newWork } = setup(async () => inAlpha);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    deps.route.mockImplementation(
      () => new Promise<RouteDecision>((resolve) => (answer = resolve)),
    );
    newWork.observe("Fix the parser in Alpha, then also the lexer");
    await pause(DEBOUNCE_MS);
    expect(newWork.snapshot().classifying).toBe(true);
    // The stale destination keeps standing in the pickers, as a stale
    // suggestion keeps its row.
    expect(newWork.snapshot().workstream).toEqual({
      id: "sec_a",
      name: "Alpha",
    });
    answer(continueParser);
    await pause(0);
    // A thread suggestion names no workstream home, so the automatic
    // destination withdraws and the row offers the thread instead.
    expect(newWork.snapshot().workstream).toBeNull();
    expect(shownSuggestion(newWork.snapshot())?.key).toBe("d_thread");
  });

  it("cancels the call in flight when the draft changes, and ignores its answer", async () => {
    let answer: (d: RouteDecision) => void = () => {};
    const { deps, newWork } = setup(
      () => new Promise<RouteDecision>((resolve) => (answer = resolve)),
    );
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    newWork.observe("Something else entirely now");
    expect(deps.cancelRoute).toHaveBeenCalledTimes(1);
    answer(continueParser);
    await pause(0);
    expect(newWork.snapshot().suggestion).toBeNull();
  });

  it("clears the suggestion and the automatic destination when the draft is emptied", async () => {
    const { newWork } = setup(async () => inAlpha);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    newWork.observe("   ");
    expect(newWork.snapshot().suggestion).toBeNull();
    expect(newWork.snapshot().workstream).toBeNull();
  });

  it("shows nothing when the router names no home", async () => {
    const { newWork } = setup(async () => ({
      ...base,
      id: "d_unsure",
      outcome: "unsure",
      candidates: [],
    }));
    newWork.observe("hmm");
    await pause();
    expect(shownSuggestion(newWork.snapshot())).toBeNull();
    expect(newWork.snapshot().workstream).toBeNull();
  });

  it("withdraws the automatic destination when the draft names no home", async () => {
    let answer: RouteDecision = inAlpha;
    const { newWork } = setup(async () => answer);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    expect(newWork.snapshot().workstream).toEqual({
      id: "sec_a",
      name: "Alpha",
    });
    answer = { ...base, id: "d_unsure", outcome: "unsure", candidates: [] };
    newWork.observe("Something unrelated entirely");
    await pause(DEBOUNCE_MS);
    expect(newWork.snapshot().workstream).toBeNull();
    expect(newWork.snapshot().pendingNew).toBeNull();
  });

  it("keeps the pickers when the same home is classified again", async () => {
    const { newWork, composer } = setup(async () => inAlpha);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    newWork.observe("Fix the parser in Alpha, please");
    await pause(DEBOUNCE_MS);
    expect(composer.setSelection).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when classification fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { newWork } = setup(async () => {
      throw new Error("No model");
    });
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    expect(newWork.snapshot()).toMatchObject({
      classifying: false,
      suggestion: null,
      error: null,
    });
    warn.mockRestore();
  });
});

// In Automatic mode a workstream suggestion fills the pickers on its own, so
// acceptance is exercised with the pickers pinned first — the state an
// override leaves behind, where the row keeps offering homes.
const pin = (newWork: NewWork) => newWork.selectWorkstream(null);

describe("accepting", () => {

  it("retains accepted semantic identity for later Enter and invalidates it on draft changes", async () => {
    const { newWork, deps } = setup(async () => ({
      ...inAlpha,
      subjectId: "feature",
    }));
    pin(newWork);
    newWork.observe("Fix the shelves");
    await pause(SHORT_PAUSE_MS);
    await newWork.accept({ submit: false });
    expect(newWork.snapshot().acceptedRoute).toEqual({
      routeId: inAlpha.id,
      sectionId: "sec_a",
      subjectId: "feature",
    });
    await newWork.submit(request("Fix the shelves"));
    expect(deps.startThread).toHaveBeenCalledWith(
      "sec_a",
      expect.anything(),
      "feature",
    );
    newWork.observe("A different task");
    expect(newWork.snapshot().acceptedRoute).toBeNull();
  });
  it("fills the workstream, project and environment for an existing workstream", async () => {
    const { newWork, composer } = setup(async () => inAlpha);
    pin(newWork);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    await newWork.accept({ submit: false });
    expect(newWork.snapshot().workstream).toEqual({
      id: "sec_a",
      name: "Alpha",
    });
    expect(composer.setSelection).toHaveBeenCalledExactlyOnceWith({
      projectId: "proj_a",
      environment: placement.environment,
    });
    expect(shownSuggestion(newWork.snapshot())).toBeNull();
    expect(newWork.snapshot().error).toBeNull();
    expect(composer.focus).toHaveBeenCalledTimes(1);
  });

  it.each([
    { decision: inAlpha, submit: false },
    { decision: inAlpha, submit: true },
    { decision: newBilling, submit: false },
    { decision: newBilling, submit: true },
    {
      decision: {
        ...inAlpha,
        placement: {
          ...placement,
          environment: { type: "project-default" as const },
        },
      },
      submit: false,
    },
  ])(
    "preserves execution settings for $decision.outcome, submit=$submit",
    async ({ decision, submit }) => {
      const { newWork, composer } = setup(async () => decision);
      pin(newWork);
      const execution: ComposerSelection = {
        providerId: "pi",
        model: "openai/gpt-6-luna",
        reasoningLevel: "high",
        serviceTier: "fast",
        permissionMode: "accept-edits",
      };
      composer.selection = {
        projectId: "proj_old",
        environment: {
          type: "host",
          hostId: "host_old",
          workspace: { type: "unmanaged", path: "/old-project" },
        },
        ...execution,
      };
      newWork.observeSelection({ providerId: "codex", model: "old-model" });
      newWork.observe("Fix the parser in Alpha");
      await pause(DEBOUNCE_MS);
      const accepting = newWork.accept({ submit });
      await vi.advanceTimersByTimeAsync(0);
      await accepting;
      const requested = {
        ...execution,
        projectId: "proj_a",
        ...(decision.placement?.environment.type === "project-default"
          ? {}
          : { environment: placement.environment }),
      };
      expect(composer.setSelection).toHaveBeenCalledExactlyOnceWith(requested);
      expect(newWork.snapshot().selection).toEqual(requested);
      expect(composer.submit).toHaveBeenCalledTimes(submit ? 1 : 0);
    },
  );

  it("creates a new workstream first, then fills the fields", async () => {
    const { deps, newWork, composer } = setup(async () => newBilling);
    pin(newWork);
    newWork.observe("Add CSV export for invoices");
    await pause(DEBOUNCE_MS);
    expect(shownSuggestion(newWork.snapshot())).toMatchObject({
      kind: "new-workstream",
      name: "Billing",
    });
    await newWork.accept({ submit: false });
    expect(deps.createWorkstream).toHaveBeenCalledWith("Billing", "Invoices");
    expect(newWork.snapshot().workstream).toEqual({
      id: "sec_new",
      name: "Billing",
    });
    expect(composer.setSelection).toHaveBeenCalledTimes(1);
  });

  it("applies a workstream suggestion and starts the thread with it", async () => {
    const { deps, newWork, composer } = setup(async () => inAlpha);
    pin(newWork);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    const accepting = newWork.accept({ submit: true });
    await vi.advanceTimersByTimeAsync(0);
    await accepting;
    expect(composer.setSelection).toHaveBeenCalledTimes(1);
    expect(composer.submit).toHaveBeenCalledTimes(1);
    expect(deps.startThread).toHaveBeenCalledExactlyOnceWith(
      "sec_a",
      request("Fix the parser in Alpha"),
    );
    expect(composer.focus).not.toHaveBeenCalled();
  });

  it("doesn't start the thread when the pickers can't be filled", async () => {
    const { deps, newWork, composer } = setup(async () => inAlpha);
    pin(newWork);
    composer.setSelection.mockRejectedValueOnce(
      new Error("Choose a project the composer can use."),
    );
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    await newWork.accept({ submit: true });
    expect(composer.submit).not.toHaveBeenCalled();
    expect(deps.startThread).not.toHaveBeenCalled();
    expect(newWork.snapshot().error).toBe(
      "Choose a project the composer can use.",
    );
  });

  it("has nothing to apply from a thread suggestion without submitting", async () => {
    const { deps, newWork, composer } = setup(async () => continueParser);
    newWork.observe("Also handle CRLF in that fix");
    await pause(DEBOUNCE_MS);
    await newWork.accept({ submit: false });
    expect(composer.submit).not.toHaveBeenCalled();
    expect(deps.sendToThread).not.toHaveBeenCalled();
    expect(shownSuggestion(newWork.snapshot())?.kind).toBe("thread");
  });

  it("sends the draft to a suggested thread through the composer's submit", async () => {
    const { deps, newWork, composer } = setup(async () => continueParser);
    newWork.observe("Also handle CRLF in that fix");
    await pause(DEBOUNCE_MS);
    await newWork.accept({ submit: true });
    expect(composer.submit).toHaveBeenCalledTimes(1);
    expect(deps.sendToThread).toHaveBeenCalledExactlyOnceWith(
      "thr_p",
      [{ type: "text", text: "Also handle CRLF in that fix", mentions: [] }],
      "trace_1",
    );
    expect(deps.startThread).not.toHaveBeenCalled();
  });

  it("reports a failed acceptance and leaves the next submit a new thread", async () => {
    const { deps, newWork, composer } = setup(async () => continueParser);
    composer.submit.mockRejectedValueOnce(new Error("Models are loading."));
    newWork.observe("Also handle CRLF in that fix");
    await pause(DEBOUNCE_MS);
    await newWork.accept({ submit: true });
    expect(newWork.snapshot()).toMatchObject({
      error: "Models are loading.",
      accepting: false,
    });
    await newWork.submit(request("Also handle CRLF in that fix"));
    expect(deps.sendToThread).not.toHaveBeenCalled();
    expect(deps.startThread).toHaveBeenCalledTimes(1);
  });

  it("hides a workstream suggestion the pickers already match", async () => {
    const { newWork } = setup(async () => inAlpha);
    newWork.selectWorkstream({ id: "sec_a", name: "Alpha" });
    newWork.observeSelection({ projectId: "proj_a" });
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    expect(newWork.snapshot().suggestion).not.toBeNull();
    expect(shownSuggestion(newWork.snapshot())).toBeNull();
  });

  it("keeps a dismissed suggestion hidden", async () => {
    const { newWork } = setup(async () => inAlpha);
    pin(newWork);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    newWork.dismiss();
    expect(shownSuggestion(newWork.snapshot())).toBeNull();
  });
});

describe("submitting", () => {
  it("starts the composer's thread in the chosen workstream", async () => {
    const { deps, newWork } = setup(async () => inAlpha);
    newWork.selectWorkstream({ id: "sec_b", name: "Beta" });
    expect(await newWork.submit(request("Write the docs"))).toEqual({
      kind: "started",
      threadId: "thr_new",
    });
    expect(deps.startThread).toHaveBeenCalledWith(
      "sec_b",
      request("Write the docs"),
    );
  });

  it("starts the thread in the automatic destination when nothing is touched", async () => {
    const { deps, newWork, composer } = setup(async () => inAlpha);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    expect(composer.setSelection).toHaveBeenCalledTimes(1);
    await newWork.submit(request("Fix the parser in Alpha"));
    expect(deps.startThread).toHaveBeenCalledWith("sec_a", expect.anything());
  });

  it("starts without a workstream when the router names no home", async () => {
    const { deps, newWork } = setup(async () => ({
      ...base,
      id: "d_unsure",
      outcome: "unsure",
      candidates: [],
    }));
    newWork.observe("hmm");
    await pause();
    await newWork.submit(request("hmm"));
    expect(deps.startThread).toHaveBeenCalledWith(null, expect.anything());
  });

  it("creates a proposed workstream on submit and files the thread there", async () => {
    const { deps, newWork } = setup(async () => newBilling);
    newWork.observe("Add CSV export for invoices");
    await pause(DEBOUNCE_MS);
    expect(newWork.snapshot().pendingNew).toMatchObject({
      name: "Billing",
      description: "Invoices",
    });
    expect(deps.createWorkstream).not.toHaveBeenCalled();
    await newWork.submit(request("Add CSV export for invoices"));
    expect(deps.createWorkstream).toHaveBeenCalledWith("Billing", "Invoices");
    expect(deps.startThread).toHaveBeenCalledWith(
      "sec_new",
      expect.anything(),
    );
  });

  it("pins the pickers when the user changes the project", async () => {
    const { newWork, composer } = setup(async () => inAlpha);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    // The composer echoing the model's own apply doesn't pin.
    expect(newWork.snapshot().pinned).toBe(false);
    newWork.observeSelection({ projectId: "proj_user" });
    expect(newWork.snapshot().pinned).toBe(true);
    // A later classification leaves the pickers alone.
    newWork.observe("Now something else");
    await pause(DEBOUNCE_MS);
    expect(composer.setSelection).toHaveBeenCalledTimes(1);
  });

  it("doesn't pin when only execution settings change", async () => {
    const { newWork } = setup(async () => inAlpha);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    newWork.observeSelection({
      projectId: "proj_a",
      environment: placement.environment,
      model: "other-model",
    });
    expect(newWork.snapshot().pinned).toBe(false);
  });

  it("unpins through selectAutomatic and re-applies the current home", async () => {
    const { newWork, composer } = setup(async () => inAlpha);
    newWork.selectWorkstream({ id: "sec_b", name: "Beta" });
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    expect(newWork.snapshot().workstream).toEqual({
      id: "sec_b",
      name: "Beta",
    });
    newWork.selectAutomatic();
    expect(newWork.snapshot()).toMatchObject({
      pinned: false,
      workstream: null,
    });
    await pause(0);
    expect(newWork.snapshot().workstream).toEqual({
      id: "sec_a",
      name: "Alpha",
    });
    expect(composer.setSelection).toHaveBeenCalledTimes(1);
  });

  it("creates a workstream named in the picker and selects it", async () => {
    const { deps, newWork } = setup(async () => inAlpha);
    await newWork.createWorkstream("  Billing ");
    expect(deps.createWorkstream).toHaveBeenCalledWith("Billing", "");
    expect(newWork.snapshot().workstream).toEqual({
      id: "sec_new",
      name: "Billing",
    });
  });
});

describe("pickerDisplay", () => {
  it("names each field state", async () => {
    const { newWork } = setup(async () => inAlpha);
    expect(pickerDisplay(newWork.snapshot())).toMatchObject({
      label: "Automatic",
      auto: true,
      destination: false,
      creating: false,
    });
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    expect(pickerDisplay(newWork.snapshot())).toMatchObject({
      label: "Alpha",
      auto: true,
      destination: true,
      creating: false,
      reason: "Fits",
    });
    newWork.selectWorkstream({ id: "sec_b", name: "Beta" });
    expect(pickerDisplay(newWork.snapshot())).toMatchObject({
      label: "Beta",
      auto: false,
      destination: true,
      reason: null,
    });
    newWork.selectWorkstream(null);
    expect(pickerDisplay(newWork.snapshot())).toMatchObject({
      label: "No workstream",
      auto: false,
      destination: false,
    });
    newWork.selectAutomatic();
    expect(pickerDisplay(newWork.snapshot())).toMatchObject({
      label: "Automatic",
      auto: true,
    });
  });

  it("marks a proposed workstream", async () => {
    const { newWork } = setup(async () => newBilling);
    newWork.observe("Add CSV export for invoices");
    await pause(DEBOUNCE_MS);
    expect(pickerDisplay(newWork.snapshot())).toMatchObject({
      label: "Billing",
      auto: true,
      destination: true,
      creating: true,
    });
  });
});

it("suggestionFrom maps each outcome to the home it names", () => {
  expect(suggestionFrom(continueParser)).toMatchObject({
    kind: "thread",
    threadId: "thr_p",
    title: "Parser fix",
  });
  expect(
    suggestionFrom({ ...inAlpha, sectionId: null, workstream: null }),
  ).toBeNull();
  expect(suggestionFrom(newBilling)).toMatchObject({
    kind: "new-workstream",
    name: "Billing",
  });
});

describe("Debug mode's record", () => {
  it("logs each classification with its prompt and result, marking superseded ones", async () => {
    let answer: (d: RouteDecision) => void = () => {};
    const { deps, newWork } = setup(
      () => new Promise<RouteDecision>((resolve) => (answer = resolve)),
    );
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    const first = answer;
    newWork.observe("Fix the parser in Alpha, and the lexer");
    await pause(DEBOUNCE_MS);
    first(inAlpha);
    answer(continueParser);
    await pause(0);
    expect(deps.route).toHaveBeenCalledTimes(2);
    expect(
      newWork.snapshot().events.map((e) => [e.kind, e.status, e.input]),
    ).toEqual([
      [
        "classify",
        "superseded",
        { prompt: "Fix the parser in Alpha", workstream: null },
      ],
      [
        "classify",
        "ok",
        { prompt: "Fix the parser in Alpha, and the lexer", workstream: null },
      ],
    ]);
    expect(newWork.snapshot().events[1]!.output).toMatchObject({
      decision: { id: "d_thread" },
      suggestion: { kind: "thread" },
    });
    expect(newWork.snapshot().decision?.id).toBe("d_thread");
  });

  it("logs acceptance and submits with their inputs, results and errors", async () => {
    const { deps, newWork } = setup(async () => inAlpha);
    pin(newWork);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    await newWork.accept({ submit: false });
    deps.startThread.mockRejectedValueOnce(new Error("Gone"));
    await expect(newWork.submit(request("Fix it"))).rejects.toThrow("Gone");
    // [pin, classify, accept, submit]
    const [, classify, accept] = newWork.snapshot().events;
    expect(classify).toMatchObject({ kind: "classify", status: "ok" });
    expect(accept).toMatchObject({
      kind: "accept",
      status: "ok",
      input: {
        suggestion: { kind: "workstream", sectionId: "sec_a" },
        submit: false,
      },
      output: {
        workstream: { id: "sec_a", name: "Alpha" },
        selection: { requested: { projectId: "proj_a" } },
      },
    });
    expect(newWork.snapshot().events.at(-1)).toMatchObject({
      kind: "submit",
      status: "failed",
      input: { startIn: "sec_a" },
      error: "Gone",
    });
  });
});

describe("nativeFlow mode", () => {
  function setupNative(
    route: (
      prompt: string,
      workstreamId: string | null,
      pickedProjectId?: string | null,
    ) => Promise<RouteDecision>,
    workstream: WorkstreamChoice = null,
  ) {
    const deps = {
      route: vi.fn(route),
      cancelRoute: vi.fn(),
      createWorkstream: vi.fn(async (name: string) => ({
        sectionId: "sec_new",
        name,
      })),
      startThread: vi.fn(async () => {
        throw new Error("Should not be called in native flow");
      }),
      sendToThread: vi.fn(async () => {}),
      sendDraftToThread: vi.fn(async () => {}),
      submitWithRoute: vi.fn(async () => {}),
    } satisfies NewWorkDeps;
    const newWork = new NewWork(deps, workstream, true);
    const composer = {
      selection: null as ComposerSelection | null,
      submit: vi.fn(async () => {}),
      setSelection: vi.fn(async (selection: ComposerSelection) => selection),
      focus: vi.fn(),
    };
    newWork.attach(composer as unknown as PluginComposerApi);
    return { deps, newWork, composer };
  }

  it("passes pickedProjectId to route when classifying", async () => {
    const { deps, newWork } = setupNative(async () => inAlpha);
    newWork.observeSelection({ projectId: "proj_picked" });
    newWork.observe("Fix the parser in Alpha project");
    await pause(DEBOUNCE_MS);
    expect(deps.route).toHaveBeenCalledWith(
      "Fix the parser in Alpha project",
      null,
      "proj_picked",
    );
  });

  it("tracks pinned correctly: presets and picks pin, classifications don't", () => {
    const { newWork } = setupNative(async () => inAlpha);
    expect(newWork.snapshot().pinned).toBe(false);

    const { newWork: explicit } = setupNative(async () => inAlpha, {
      id: "sec_a",
      name: "Alpha",
    });
    expect(explicit.snapshot().pinned).toBe(true);

    newWork.selectWorkstream({ id: "sec_b", name: "Beta" });
    expect(newWork.snapshot().pinned).toBe(true);

    newWork.selectWorkstream(null);
    expect(newWork.snapshot().pinned).toBe(true);
  });

  it("accepts a continuation by sending draft to thread without host composer submit", async () => {
    const { deps, newWork, composer } = setupNative(async () => continueParser);
    newWork.observe("Also handle CRLF line endings");
    await pause(DEBOUNCE_MS);
    const accepting = newWork.accept({ submit: true });
    await vi.advanceTimersByTimeAsync(0);
    await accepting;
    expect(deps.sendDraftToThread).toHaveBeenCalledWith("thr_p", "trace_1");
    expect(composer.submit).not.toHaveBeenCalled();
    expect(newWork.snapshot().settled).toBe("d_thread");
    expect(newWork.snapshot().events.at(-1)).toMatchObject({
      kind: "accept",
      status: "ok",
    });
  });

  it("accepts an existing workstream by calling submitWithRoute", async () => {
    const { deps, newWork, composer } = setupNative(async () => inAlpha);
    newWork.selectWorkstream(null);
    newWork.observe("Fix tabs in Alpha parser");
    await pause(DEBOUNCE_MS);
    const accepting = newWork.accept({ submit: true });
    await vi.advanceTimersByTimeAsync(0);
    await accepting;
    expect(deps.submitWithRoute).toHaveBeenCalledWith("d_alpha", "sec_a");
    expect(composer.submit).not.toHaveBeenCalled();
    expect(newWork.snapshot().settled).toBe("d_alpha");
  });

  it("accepts a new-workstream suggestion by creating it and calling submitWithRoute", async () => {
    const { deps, newWork, composer } = setupNative(async () => newBilling);
    newWork.selectWorkstream(null);
    newWork.observe("Add invoice export features");
    await pause(DEBOUNCE_MS);
    const accepting = newWork.accept({ submit: true });
    await vi.advanceTimersByTimeAsync(0);
    await accepting;
    expect(deps.createWorkstream).toHaveBeenCalledWith("Billing", "Invoices");
    expect(deps.submitWithRoute).toHaveBeenCalledWith("d_new", "sec_new");
    expect(composer.submit).not.toHaveBeenCalled();
    expect(newWork.snapshot().settled).toBe("d_new");
    expect(newWork.snapshot().workstream).toEqual({
      id: "sec_new",
      name: "Billing",
    });
  });

  it("reports errors when sendDraftToThread fails in nativeFlow", async () => {
    const { deps, newWork } = setupNative(async () => continueParser);
    deps.sendDraftToThread.mockRejectedValueOnce(new Error("Send failed"));
    newWork.observe("Also handle CRLF line endings");
    await pause(DEBOUNCE_MS);
    const accepting = newWork.accept({ submit: true });
    await vi.advanceTimersByTimeAsync(0);
    await accepting;
    expect(newWork.snapshot().error).toBe("Send failed");
    expect(newWork.snapshot().events.at(-1)).toMatchObject({
      kind: "accept",
      status: "failed",
    });
  });
});
