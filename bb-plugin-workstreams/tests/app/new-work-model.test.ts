import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ComposerSelection,
  NewThreadRequest,
  PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import {
  NewWork,
  shownSuggestion,
  suggestionFrom,
  type NewWorkDeps,
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

function setup(route: (prompt: string) => Promise<RouteDecision>) {
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
  const newWork = new NewWork(deps);
  const composer = {
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
  it("runs once typing pauses and shows its suggestion", async () => {
    const { deps, newWork } = setup(async () => inAlpha);
    newWork.observe("Fix");
    newWork.observe("Fix the");
    await vi.advanceTimersByTimeAsync(SHORT_PAUSE_MS - 1);
    expect(deps.route).not.toHaveBeenCalled();
    await pause(1);
    expect(deps.route).toHaveBeenCalledExactlyOnceWith("Fix the");
    expect(shownSuggestion(newWork.snapshot())).toMatchObject({
      kind: "workstream",
      sectionId: "sec_a",
      name: "Alpha",
    });
  });

  it("keeps the last suggestion up while newer text is classified", async () => {
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
    expect(shownSuggestion(newWork.snapshot())?.key).toBe("d_alpha");
    answer(continueParser);
    await pause(0);
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

  it("clears the suggestion when the draft is emptied", async () => {
    const { newWork } = setup(async () => inAlpha);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    newWork.observe("   ");
    expect(newWork.snapshot().suggestion).toBeNull();
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

describe("accepting", () => {
  it("fills the workstream, project and environment for an existing workstream", async () => {
    const { newWork, composer } = setup(async () => inAlpha);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    await newWork.accept();
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

  it("creates a new workstream first, then fills the fields", async () => {
    const { deps, newWork, composer } = setup(async () => newBilling);
    newWork.observe("Add CSV export for invoices");
    await pause(DEBOUNCE_MS);
    expect(shownSuggestion(newWork.snapshot())).toMatchObject({
      kind: "new-workstream",
      name: "Billing",
    });
    await newWork.accept();
    expect(deps.createWorkstream).toHaveBeenCalledWith("Billing", "Invoices");
    expect(newWork.snapshot().workstream).toEqual({
      id: "sec_new",
      name: "Billing",
    });
    expect(composer.setSelection).toHaveBeenCalledTimes(1);
  });

  it("sends the draft to a suggested thread through the composer's submit", async () => {
    const { deps, newWork, composer } = setup(async () => continueParser);
    newWork.observe("Also handle CRLF in that fix");
    await pause(DEBOUNCE_MS);
    await newWork.accept();
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
    await newWork.accept();
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

  it("starts without a workstream by default, ignoring the suggestion", async () => {
    const { deps, newWork } = setup(async () => inAlpha);
    newWork.observe("Fix the parser in Alpha");
    await pause(DEBOUNCE_MS);
    await newWork.submit(request("Fix the parser in Alpha"));
    expect(deps.startThread).toHaveBeenCalledWith(null, expect.anything());
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
