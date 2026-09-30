import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Intake } from "../../src/app/composer/intake.ts";
import type { Environment } from "../../src/app/composer/intake.ts";
import type { RouteDecision } from "../../src/server/router.ts";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
const prompt = "Fix the parser";
const base = {
  id: "d1",
  confidence: "high" as const,
  reason: "",
  subject: null,
  traceId: null,
};
const decision: RouteDecision = {
  ...base,
  outcome: "new-thread",
  sectionId: "sec_a",
  workstream: "Alpha",
  title: prompt,
  placement: {
    projectId: "proj_a",
    environment: { type: "project-default" },
    label: "checkout",
  },
};
const unsure: RouteDecision = {
  ...base,
  outcome: "unsure",
  candidates: [{ kind: "thread", threadId: "thr_a", title: "Parser" }],
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function synchronize(intake: Intake) {
  const selection = intake.selection();
  if (selection) intake.reconcileSelection(selection, selection);
}
async function ready(intake: Intake) {
  intake.observe(prompt, "incidental_host_project");
  await vi.runAllTimersAsync();
  synchronize(intake);
}
it("automatic fill uses inference and ignores the host's incidental project", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, null, null);
  await ready(intake);
  expect(route).toHaveBeenCalledWith({ prompt, intent: {} });
  expect(intake.snapshot()).toMatchObject({
    project: { value: "proj_a", source: "automatic" },
    environment: { source: "automatic" },
  });
  synchronize(intake);
  expect(intake.canSubmit()).toBe(true);
  expect((await intake.forSubmit(prompt)).intent).toEqual({});
});
it("fixes a wrong workstream and keeps only that override across prompt edits", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, null, null);
  await ready(intake);
  intake.selectWorkstream("sec_b", "Beta");
  intake.observe("Fix another parser");
  await vi.runAllTimersAsync();
  expect(route).toHaveBeenLastCalledWith({
    prompt: "Fix another parser",
    intent: { destination: { kind: "workstream", id: "sec_b" } },
  });
  expect(intake.effectiveAction()).toBe("new-thread");
  expect(intake.snapshot().action.source).toBe("automatic");
  intake.revertField("destination");
  await vi.runAllTimersAsync();
  expect(intake.snapshot().destination.source).toBe("automatic");
});
it("switches existing thread to new thread and preserves explicitly selected action", async () => {
  const route = vi.fn().mockResolvedValue({
    ...base,
    outcome: "continue",
    threadId: "thr_a",
    threadTitle: "Parser",
    workstream: "Alpha",
    sectionId: "sec_a",
  });
  const intake = new Intake(route, null, null);
  await ready(intake);
  expect(intake.snapshot().redirectPending).toBe(true);
  expect(intake.effectiveAction()).toBe("automatic");
  intake.acceptRedirect();
  expect(intake.effectiveAction()).toBe("send-message");
  intake.selectAction("new-thread");
  expect(intake.snapshot().destination.value).toEqual({
    kind: "workstream",
    id: "sec_a",
    name: "Alpha",
  });
  intake.selectWorkstream("sec_b", "Beta");
  expect(intake.intent()).toEqual({
    action: "new-thread",
    destination: { kind: "workstream", id: "sec_b" },
  });
  route.mockResolvedValue(decision);
  await vi.runAllTimersAsync();
  expect(intake.effectiveAction()).toBe("new-thread");
});
it("placement overrides survive edits and each reverts independently", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, null, null);
  await ready(intake);
  intake.selectProject("mine");
  intake.selectEnvironment({
    type: "host",
    workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
  });
  intake.observe("Fix another parser");
  await vi.runAllTimersAsync();
  expect(intake.snapshot().project).toEqual({
    value: "mine",
    source: "manual",
  });
  expect(intake.snapshot().environment.source).toBe("manual");
  intake.revertField("environment");
  await vi.runAllTimersAsync();
  expect(intake.snapshot().project.source).toBe("manual");
  expect(intake.snapshot().environment.source).toBe("automatic");
  intake.revertField("project");
  await vi.runAllTimersAsync();
  expect(intake.snapshot().project.source).toBe("automatic");
});
it("pending, ambiguous and failed Enter keep draft and do not perform routing from the guard", async () => {
  const route = vi.fn().mockResolvedValue(unsure);
  const intake = new Intake(route, null, null);
  intake.observe(prompt);
  await expect(intake.forSubmit(prompt)).rejects.toThrow("Wait");
  expect(route).not.toHaveBeenCalled();
  expect(intake.snapshot().text).toBe(prompt);
  await vi.runAllTimersAsync();
  await expect(intake.forSubmit(prompt)).rejects.toThrow("Choose");
  route.mockRejectedValue(new Error("offline"));
  intake.retry();
  await vi.runAllTimersAsync();
  await expect(intake.forSubmit(prompt)).rejects.toThrow("Retry");
  expect(intake.snapshot().text).toBe(prompt);
  route.mockResolvedValue(decision);
  intake.retry();
  await vi.runAllTimersAsync();
  synchronize(intake);
  expect(intake.canSubmit()).toBe(true);
});
it("no workstream keeps placement unresolved until inferred or chosen, and preserves manual project", async () => {
  const route = vi.fn().mockResolvedValue({
    ...decision,
    sectionId: null,
    workstream: null,
    placement: null,
  });
  const intake = new Intake(route, null, null);
  intake.selectUnassigned();
  await ready(intake);
  expect(intake.intent()).toEqual({ destination: { kind: "none" } });
  expect(intake.canSubmit()).toBe(false);
  intake.selectProject("mine");
  route.mockResolvedValue({
    ...decision,
    sectionId: null,
    workstream: null,
    placement: {
      projectId: "mine",
      environment: { type: "project-default" },
      label: "checkout",
    },
  });
  await vi.runAllTimersAsync();
  intake.observe("Write onboarding guide");
  await vi.runAllTimersAsync();
  expect(intake.snapshot().destination.value.kind).toBe("unassigned");
  synchronize(intake);
  expect(intake.canSubmit()).toBe(true);
  expect(intake.intent().placement?.projectId).toBe("mine");
  intake.revertField("project");
  route.mockResolvedValue({ ...decision, sectionId: null, workstream: null });
  await vi.runAllTimersAsync();
  expect(intake.snapshot().project.value).toBe("proj_a");
});
it("sidebar destination is explicit and routing never requests classification without it", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, "sec_a", "Alpha");
  intake.observe("");
  await vi.runAllTimersAsync();
  expect(route).not.toHaveBeenCalled();
  await ready(intake);
  expect(route).toHaveBeenCalledWith({
    prompt,
    intent: { destination: { kind: "workstream", id: "sec_a" } },
  });
  intake.revertField("destination");
  await vi.runAllTimersAsync();
  expect(route).toHaveBeenLastCalledWith({ prompt, intent: {} });
});
it("late results cannot undo manual fields or resolve a changed draft", async () => {
  let finish!: (value: RouteDecision) => void;
  const cancel = vi.fn();
  const route = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const intake = new Intake(route, null, null, cancel);
  intake.observe(prompt);
  await vi.runAllTimersAsync();
  intake.selectProject("mine");
  intake.selectUnassigned();
  finish(decision);
  await Promise.resolve();
  expect(intake.snapshot().decision).toBeNull();
  expect(intake.snapshot().project.value).toBe("mine");
  expect(cancel).toHaveBeenCalledTimes(1);
  intake.dispose();
});
it("stale environment catalogs cannot validate or overwrite a new project", async () => {
  let finish!: (value: { id: string; name: string }[]) => void;
  const sdk = {
    environments: {
      list: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValueOnce([{ id: "env_b", name: "B" }]),
    },
  } as unknown as PluginBrowserBbSdk;
  const intake = new Intake(vi.fn().mockResolvedValue(decision), null, null);
  intake.selectProject("a");
  const pending = intake.loadEnvironments(sdk, "a");
  intake.selectProject("b");
  intake.selectEnvironment({ type: "reuse", environmentId: "env_b" });
  await intake.loadEnvironments(sdk, "b");
  finish([{ id: "env_a", name: "A" }]);
  await pending;
  expect(intake.snapshot().environments).toEqual([{ id: "env_b", name: "B" }]);
  expect(intake.snapshot().environment.source).toBe("manual");
});
it("invalid reuse environment resets automatically with an announcement", async () => {
  const sdk = {
    environments: { list: async () => [] },
  } as unknown as PluginBrowserBbSdk;
  const intake = new Intake(vi.fn().mockResolvedValue(decision), null, null);
  intake.selectProject("a");
  intake.selectEnvironment({ type: "reuse", environmentId: "old" });
  intake.selectProject("b");
  await intake.loadEnvironments(sdk, "b");
  expect(intake.snapshot().environment).toEqual({
    value: { type: "project-default" },
    source: "automatic",
  });
  expect(intake.snapshot().announcement).toContain("reset");
});
it("same-project environment changes update host selection, independently of project", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, null, null);
  await ready(intake);
  expect(intake.snapshot().project.value).toBe("proj_a");
  expect(intake.selection()).toBeNull();
  route.mockResolvedValue({
    ...decision,
    id: "d2",
    placement: {
      projectId: "proj_a",
      environment: { type: "reuse", environmentId: "env_b" },
      label: "worktree",
    },
  });
  intake.retry();
  await vi.runAllTimersAsync();
  expect(intake.selection()?.environment).toEqual({
    type: "reuse",
    environmentId: "env_b",
  });
});
it("new workstream name is independently editable and revertible", async () => {
  const route = vi.fn().mockResolvedValue({
    ...base,
    outcome: "new-workstream",
    placement: decision.placement,
    name: "Offline sync",
    description: "",
    title: prompt,
  });
  const intake = new Intake(route, null, null);
  await ready(intake);
  intake.selectName("My spike");
  await vi.runAllTimersAsync();
  expect(intake.intent()).toEqual({ workstreamName: "My spike" });
  intake.revertField("name");
  await vi.runAllTimersAsync();
  expect(intake.snapshot().name).toEqual({
    value: "Offline sync",
    source: "automatic",
  });
});
it("editing or clearing a proposed redirect invalidates its actions", async () => {
  const route = vi.fn().mockResolvedValue({
    ...base,
    outcome: "continue",
    threadId: "thr_a",
    threadTitle: "Parser",
    sectionId: "sec_a",
    workstream: "Alpha",
  });
  const intake = new Intake(route, null, null);
  await ready(intake);
  expect(intake.snapshot().redirectPending).toBe(true);
  intake.observe("A different request");
  expect(intake.snapshot().redirectPending).toBe(false);
  expect(intake.effectiveAction()).toBe("automatic");
  intake.acceptRedirect();
  expect(intake.snapshot().redirectPending).toBe(false);
  intake.dispose();
});

it("dismissed redirects preserve an explicit fallback destination through rerouting", async () => {
  const route = vi.fn().mockResolvedValue({
    ...base,
    outcome: "continue",
    threadId: "thr_a",
    threadTitle: "Parser",
    sectionId: "sec_a",
    workstream: "Alpha",
  });
  const intake = new Intake(route, null, null);
  await ready(intake);
  intake.dismissRedirect();
  expect(intake.snapshot().destination).toEqual({
    source: "manual",
    value: { kind: "workstream", id: "sec_a", name: "Alpha" },
  });
  expect(intake.intent()).toEqual({
    action: "new-thread",
    destination: { kind: "workstream", id: "sec_a" },
  });
  intake.dispose();
});

it("a pending redirect gates submit until it is accepted", async () => {
  const intake = new Intake(
    vi.fn().mockResolvedValue({
      ...base,
      outcome: "continue",
      threadId: "thr_a",
      threadTitle: "Parser",
      sectionId: "sec_a",
      workstream: "Alpha",
    }),
    null,
    null,
  );
  await ready(intake);
  expect(intake.snapshot().redirectPending).toBe(true);
  expect(intake.effectiveAction()).toBe("automatic");
  expect(intake.lockedThread()).toBeUndefined();
  expect(intake.canSubmit()).toBe(false);
  intake.acceptRedirect();
  expect(intake.snapshot().redirectPending).toBe(false);
  intake.dispose();
});

it("dismissed redirects restore manual placement and create-thread intent", async () => {
  const intake = new Intake(
    vi.fn().mockResolvedValue({
      ...base,
      outcome: "continue",
      threadId: "thr_a",
      threadTitle: "Parser",
      sectionId: "sec_a",
      workstream: "Alpha",
    }),
    null,
    null,
  );
  intake.selectProject("mine");
  const environment: Environment = {
    type: "reuse",
    environmentId: "mine_env",
  };
  intake.selectEnvironment(environment);
  await ready(intake);
  expect(intake.effectiveAction()).toBe("automatic");
  intake.dismissRedirect();
  expect(intake.effectiveAction()).toBe("new-thread");
  expect(intake.snapshot().environment).toEqual({
    source: "manual",
    value: environment,
  });
  intake.dispose();
});

it("invalidates a manual reuse environment atomically when the project changes", async () => {
  const intake = new Intake(vi.fn().mockResolvedValue(decision), null, null);
  intake.selectProject("a");
  intake.selectEnvironment({ type: "reuse", environmentId: "old" });
  intake.selectProject("b");
  expect(intake.snapshot().environment).toEqual({
    source: "automatic",
    value: { type: "project-default" },
  });
  expect(intake.snapshot().announcement).toContain("reset");
  intake.dispose();
});

it("old A acknowledgements cannot enable the final A in an A to B to A selection queue", async () => {
  const intake = new Intake(vi.fn().mockResolvedValue(decision), null, null);
  await ready(intake);
  intake.selectEnvironment({ type: "reuse", environmentId: "A" });
  await intake.resolve();
  const firstA = intake.selection()!;
  intake.selectEnvironment({ type: "reuse", environmentId: "B" });
  await intake.resolve();
  const b = intake.selection()!;
  intake.selectEnvironment({ type: "reuse", environmentId: "A" });
  await intake.resolve();
  const finalA = intake.selection()!;
  intake.reconcileSelection(firstA, firstA);
  expect(intake.canSubmit()).toBe(false);
  intake.reconcileSelection(b, b);
  expect(intake.canSubmit()).toBe(false);
  intake.selectionFailed("obsolete error", firstA);
  expect(intake.snapshot().selectionError).toBeNull();
  intake.reconcileSelection(finalA, finalA);
  expect(intake.canSubmit()).toBe(true);
  intake.dispose();
});

const defaultWorktree: Environment = {
  type: "host",
  hostId: "host_a",
  workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
};
const namedWorktree: Environment = {
  type: "host",
  hostId: "host_a",
  workspace: {
    type: "managed-worktree",
    baseBranch: { kind: "named", name: "main" },
  },
};
const providerWorktree = (
  branch: { kind: "default" } | { kind: "named"; name: string },
): Environment => ({
  type: "provider",
  environmentProviderId: "git-worktree",
  machine: { type: "existing", hostId: "host_a" },
  inputs: { branch },
});
for (const mode of ["automatic", "manual"] as const) {
  for (const [representation, appliedEnvironment] of [
    ["host named branch", namedWorktree],
    ["provider default branch", providerWorktree({ kind: "default" })],
    [
      "provider named branch",
      providerWorktree({ kind: "named", name: "main" }),
    ],
  ] as const) {
    it(`acknowledges ${mode} worktree as ${representation} without changing intent`, async () => {
      const intake = new Intake(
        vi.fn().mockResolvedValue({
          ...decision,
          placement: { ...decision.placement!, environment: defaultWorktree },
        }),
        null,
        null,
      );
      intake.observe(prompt);
      await intake.resolve();
      if (mode === "manual") {
        intake.selectEnvironment(defaultWorktree);
        await intake.resolve();
      }
      const selection = intake.selection()!;
      intake.reconcileSelection(selection, {
        ...selection,
        environment: appliedEnvironment,
      });
      expect(intake.canSubmit()).toBe(true);
      expect(intake.snapshot().environment).toEqual({
        value: defaultWorktree,
        source: mode,
      });
      expect((await intake.forSubmit(prompt)).intent).toEqual(
        mode === "manual"
          ? { placement: { environment: defaultWorktree } }
          : {},
      );
      intake.dispose();
    });
  }
}
it("rejects real project, host, environment and explicit branch substitutions", async () => {
  for (const applied of [
    { projectId: "other_project", environment: namedWorktree },
    {
      projectId: "proj_a",
      environment: { ...namedWorktree, hostId: "other_host" },
    },
    {
      projectId: "proj_a",
      environment: { type: "reuse", environmentId: "other" },
    },
  ] as const) {
    const intake = new Intake(vi.fn().mockResolvedValue(decision), null, null);
    await ready(intake);
    intake.selectEnvironment(defaultWorktree);
    await intake.resolve();
    intake.reconcileSelection(intake.selection()!, applied);
    expect(intake.canSubmit()).toBe(false);
    expect(intake.snapshot().selectionError).toBeTruthy();
    intake.dispose();
  }
  const intake = new Intake(vi.fn().mockResolvedValue(decision), null, null);
  await ready(intake);
  intake.selectEnvironment(namedWorktree);
  await intake.resolve();
  intake.reconcileSelection(intake.selection()!, {
    projectId: "proj_a",
    environment: {
      ...namedWorktree,
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "different" },
      },
    },
  });
  expect(intake.canSubmit()).toBe(false);
  expect(intake.snapshot().selectionError).toBeTruthy();
  intake.dispose();
});
it("acknowledges checkout provider sugar while rejecting changed provider, host, path and branch", async () => {
  const checkout: Environment = {
    type: "host",
    hostId: "host_a",
    workspace: { type: "unmanaged", path: null },
  };
  const provider: Environment = {
    type: "provider",
    environmentProviderId: "project-checkout",
    machine: { type: "existing", hostId: "host_a" },
    inputs: {},
  };
  for (const [requested, applied, accepted] of [
    [checkout, provider, true],
    [checkout, { ...provider, environmentProviderId: "different" }, false],
    [
      checkout,
      { ...provider, machine: { type: "existing", hostId: "other" } },
      false,
    ],
    [checkout, { ...provider, inputs: { path: "/different" } }, false],
    [
      { ...checkout, workspace: { type: "unmanaged", path: "/chosen" } },
      provider,
      false,
    ],
    [
      {
        ...checkout,
        workspace: {
          type: "unmanaged",
          path: null,
          branch: { kind: "existing", name: "chosen" },
        },
      },
      provider,
      false,
    ],
    [
      namedWorktree,
      providerWorktree({ kind: "named", name: "different" }),
      false,
    ],
    [
      defaultWorktree,
      {
        ...providerWorktree({ kind: "default" }),
        inputs: { branch: { kind: "default" }, path: "/unexpected" },
      },
      false,
    ],
  ] as [Environment, Environment, boolean][]) {
    const intake = new Intake(vi.fn().mockResolvedValue(decision), null, null);
    await ready(intake);
    intake.selectEnvironment(requested);
    await intake.resolve();
    const selection = intake.selection()!;
    intake.reconcileSelection(selection, {
      ...selection,
      environment: applied,
    });
    expect(intake.canSubmit()).toBe(accepted);
    expect(intake.snapshot().environment.value).toEqual(requested);
    intake.dispose();
  }
});
it("identical native settings still acknowledge the current thread target independently", async () => {
  let target = "A";
  const intake = new Intake(
    async () => ({
      ...base,
      outcome: "continue",
      threadId: target,
      threadTitle: target,
      sectionId: null,
      workstream: null,
    }),
    null,
    null,
  );
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({
        id: threadId,
        title: threadId,
        sectionId: null,
        projectId: "proj_a",
        providerId: "pi",
        environmentId: "same_env",
        environment: { name: "Same checkout" },
      }),
      defaultExecutionOptions: async () => ({
        providerId: "codex",
        model: "gpt-5",
      }),
    },
  } as unknown as PluginBrowserBbSdk;
  intake.observe("Continue A");
  await intake.resolve();
  await intake.loadThread(sdk, "A");
  const first = intake.selection()!;
  intake.reconcileSelection(first, first);
  expect(intake.snapshot().redirectPending).toBe(true);
  intake.acceptRedirect();
  const accepted = intake.selection()!;
  intake.reconcileSelection(accepted, accepted);
  expect(intake.canSubmit()).toBe(true);
  expect(intake.snapshot().synchronizedThread).toBe("A");
  intake.dispose();
});

it("a project on another host resets an incompatible manual new worktree and announces it", async () => {
  const sdk = {
    projects: {
      list: async () => [
        {
          id: "a",
          name: "A",
          sources: [{ hostId: "host_a", isDefault: true }],
        },
        {
          id: "b",
          name: "B",
          sources: [{ hostId: "host_b", isDefault: true }],
        },
      ],
    },
    threads: { list: async () => [] },
    system: { config: async () => ({ primaryHostId: "host_a" }) },
    environments: { list: async () => [] },
  } as unknown as PluginBrowserBbSdk;
  const intake = new Intake(vi.fn().mockResolvedValue(decision), null, null);
  await intake.loadCatalogs(sdk);
  intake.selectProject("a");
  intake.selectEnvironment({
    type: "host",
    hostId: "host_a",
    workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
  });
  intake.selectProject("b");
  await intake.loadEnvironments(sdk, "b");
  expect(intake.snapshot().environment).toEqual({
    source: "automatic",
    value: { type: "project-default" },
  });
  expect(intake.snapshot().announcement).toContain("reset");
  intake.observe("Continue editing");
  expect(intake.snapshot().announcement).toBe("");
  intake.dispose();
});
it("Automatic menu previews retain inferred values instead of echoing forced manual results", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, null, null);
  await ready(intake);
  intake.selectWorkstream("sec_b", "Beta");
  intake.selectProject("mine");
  intake.selectEnvironment({ type: "reuse", environmentId: "mine_env" });
  route.mockResolvedValue({
    ...decision,
    sectionId: "sec_b",
    workstream: "Beta",
    placement: {
      projectId: "mine",
      environment: { type: "reuse", environmentId: "mine_env" },
      label: "My environment",
    },
  });
  await intake.resolve();
  expect(intake.automaticPreview("destination")).toBe("Alpha");
  expect(intake.automaticPreview("environment")).toBe("checkout");
  intake.revertField("project");
  expect(intake.snapshot().project.value).toBe("proj_a");
  intake.dispose();
});
