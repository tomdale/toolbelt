import { afterEach, expect, it } from "vitest";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { Intake } from "../../src/app/composer/intake.ts";
import type { RouteDecision } from "../../src/server/router.ts";
import { fakeWorld } from "../server/fake-bb.ts";
let world: Awaited<ReturnType<typeof fakeWorld>> | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});
async function setup(initial: Record<string, unknown>) {
  let answer = initial;
  const w = (world = await fakeWorld({
    complete: ({ prompt }) =>
      prompt.includes("Someone is starting new work")
        ? JSON.stringify(answer)
        : JSON.stringify({ recap: "r", state: "done", subject: null }),
  }));
  const section = w.addSection("Alpha");
  w.addThread("a1", {
    sectionId: section.id,
    projectId: "proj_1",
    environmentId: "env_1",
    title: "Alpha parser",
  });
  await w.harness.behavior.callRpc("refresh", null);
  const intake = new Intake(
    (options) =>
      w.harness.behavior.callRpc("route", {
        ...options,
        offerNewThread: true,
      }) as Promise<RouteDecision>,
    null,
    null,
  );
  const execute = async (prompt: string) => {
    const { decision, intent, choice } = await intake.forSubmit(prompt);
    return w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      intent,
      choice,
      prompt,
      execution: {
        projectId: intake.snapshot().project.value,
        environment: intake.snapshot().environment.value,
      },
    });
  };
  return {
    w,
    intake,
    execute,
    section,
    answer: (value: Record<string, unknown>) => {
      answer = value;
    },
  };
}
const threadAnswer = {
  outcome: "new-thread",
  workstream: "alpha",
  title: "Fix parser",
  code: true,
  confidence: "high",
  reason: "Parser work",
};
const synchronize = (intake: Intake) => {
  const selection = intake.selection();
  if (selection) intake.reconcileSelection(selection, selection);
};
it("real route/execute blocks creation until native placement is acknowledged", async () => {
  const { intake, execute, w } = await setup(threadAnswer);
  intake.observe("Fix the parser");
  await intake.resolve();
  expect(intake.canSubmit()).toBe(false);
  await expect(execute("Fix the parser")).rejects.toThrow("Choose");
  expect(w.spawned).toHaveLength(0);
  synchronize(intake);
  expect(intake.canSubmit()).toBe(true);
  await execute("Fix the parser");
  expect(w.spawned[0]).toMatchObject({
    projectId: "proj_1",
    environment: intake.snapshot().environment.value,
  });
  intake.dispose();
});
it("real inferred continuation keeps the exact preview intent after manual creation placement", async () => {
  const { intake, execute, w, answer } = await setup(threadAnswer);
  intake.observe("Fix the parser");
  await intake.resolve();
  synchronize(intake);
  intake.selectProject("proj_1");
  intake.selectEnvironment({ type: "reuse", environmentId: "env_1" });
  answer({
    outcome: "continue",
    threadId: "a1",
    confidence: "high",
    reason: "Same task",
  });
  intake.observe("Continue the Alpha parser fix");
  await intake.resolve();
  const sdk = {
    threads: {
      get: async () => ({
        ...w.threads.get("a1"),
        environment: { name: "Parser checkout" },
      }),
      defaultExecutionOptions: async () => ({
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "auto",
      }),
    },
  } as unknown as PluginBrowserBbSdk;
  await intake.loadThread(sdk, "a1");
  synchronize(intake);
  expect(intake.effectiveAction()).toBe("new-thread");
  await intake.continueSuggestion();
  await expect(execute("Continue the Alpha parser fix")).resolves.toMatchObject(
    { threadId: "a1" },
  );
  expect(w.sent).toHaveLength(1);
  expect(w.spawned).toHaveLength(0);
  intake.dispose();
});
it("real inferred continuation creates its previewed new thread unless continued", async () => {
  const { intake, execute, w, section } = await setup({
    outcome: "continue",
    threadId: "a1",
    confidence: "high",
    reason: "Same task",
  });
  intake.observe("Continue the Alpha parser fix");
  await intake.resolve();
  synchronize(intake);
  expect(intake.snapshot().suggestion?.threadId).toBe("a1");
  await execute("Continue the Alpha parser fix");
  expect(w.sent).toHaveLength(0);
  expect(w.spawned[0]).toMatchObject({
    sectionId: section.id,
    projectId: "proj_1",
  });
  intake.dispose();
});
it("real continuation of a suggestion for older text sends the current text", async () => {
  const { intake, execute, w } = await setup({
    outcome: "continue",
    threadId: "a1",
    confidence: "high",
    reason: "Same task",
  });
  intake.observe("Continue the Alpha parser fix");
  await intake.resolve();
  intake.observe("Continue the Alpha parser fix for tabs");
  await intake.continueSuggestion();
  await execute("Continue the Alpha parser fix for tabs");
  expect(w.spawned).toHaveLength(0);
  expect(w.sent).toEqual([
    expect.objectContaining({ threadId: "a1", mode: "queue-if-active" }),
  ]);
  intake.dispose();
});
it("explicit creation accepts a workstream name edit", async () => {
  const { intake, execute, w } = await setup({
    outcome: "new-workstream",
    name: "Offline sync",
    description: "Sync spike",
    title: "Spike",
    code: true,
    confidence: "high",
    reason: "New work",
  });
  intake.selectAction("new-workstream");
  intake.selectProject("proj_1");
  intake.observe("Start a spike on offline synchronization");
  await intake.resolve();
  synchronize(intake);
  intake.selectName("Renamed spike");
  await intake.resolve();
  synchronize(intake);
  await execute("Start a spike on offline synchronization");
  expect(w.sections.some((s) => s.name === "Renamed spike")).toBe(true);
  expect(w.sections.some((s) => s.name === "Offline sync")).toBe(false);
  intake.dispose();
});
it("real unassigned execution uses the chosen project and remains unfiled", async () => {
  const { intake, execute, w } = await setup({
    outcome: "unsure",
    candidates: [],
    confidence: "low",
    reason: "Unrelated",
  });
  intake.selectUnassigned();
  intake.selectProject("proj_other");
  intake.observe("Write an onboarding checklist");
  await intake.resolve();
  synchronize(intake);
  await execute("Write an onboarding checklist");
  expect(w.spawned[0]).toMatchObject({
    projectId: "proj_other",
    sectionId: null,
  });
  intake.dispose();
});
it("real execution uses the latest manual environment within the same project", async () => {
  const { intake, execute, w } = await setup(threadAnswer);
  intake.observe("Fix the parser");
  await intake.resolve();
  synchronize(intake);
  intake.selectEnvironment({ type: "reuse", environmentId: "env_changed" });
  await intake.resolve();
  expect(intake.canSubmit()).toBe(false);
  synchronize(intake);
  await execute("Fix the parser");
  expect(w.spawned[0]).toMatchObject({
    projectId: "proj_1",
    environment: { type: "reuse", environmentId: "env_changed" },
  });
  intake.dispose();
});
it("real automatic continuation then creation retains independent manual placement", async () => {
  const { intake, execute, w, answer } = await setup(threadAnswer);
  intake.observe("Fix the parser");
  await intake.resolve();
  intake.selectProject("proj_other");
  intake.selectEnvironment({
    type: "host",
    hostId: "host_1",
    workspace: { type: "unmanaged", path: null },
  });
  await intake.resolve();
  synchronize(intake);
  const placement = {
    projectId: "proj_other",
    environment: intake.snapshot().environment.value,
  };
  answer({
    outcome: "continue",
    threadId: "a1",
    confidence: "high",
    reason: "Same task",
  });
  intake.observe("Continue the existing parser fix");
  await intake.resolve();
  expect(intake.snapshot().suggestion?.threadId).toBe("a1");
  // The new thread offered beside the suggestion keeps the manual placement.
  expect(intake.snapshot().decision).toMatchObject({
    outcome: "new-thread",
    placement,
  });
  answer(threadAnswer);
  intake.observe("Start another parser fix");
  await intake.resolve();
  expect(intake.snapshot().project.value).toBe("proj_other");
  expect(intake.snapshot().decision).toMatchObject({ placement });
  synchronize(intake);
  expect((await intake.forSubmit("Start another parser fix")).intent).toEqual({
    placement,
  });
  intake.completeSubmit();
  await execute("Start another parser fix");
  expect(w.spawned[0]).toMatchObject(placement);
  intake.dispose();
});
it("real execution preserves manual host worktree intent after provider acknowledgement", async () => {
  const { intake, execute, w } = await setup(threadAnswer);
  intake.observe("Fix the parser");
  await intake.resolve();
  const environment = {
    type: "host" as const,
    hostId: "host_1",
    workspace: {
      type: "managed-worktree" as const,
      baseBranch: { kind: "default" as const },
    },
  };
  intake.selectEnvironment(environment);
  await intake.resolve();
  const selection = intake.selection()!;
  intake.reconcileSelection(selection, {
    ...selection,
    environment: {
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing", hostId: "host_1" },
      inputs: { branch: { kind: "named", name: "main" } },
    },
  });
  expect(intake.canSubmit()).toBe(true);
  await execute("Fix the parser");
  expect(w.spawned[0]).toMatchObject({ environment });
  intake.dispose();
});
