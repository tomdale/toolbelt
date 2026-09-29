import { afterEach, describe, expect, it } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld } from "./fake-bb.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

type Decision = {
  id: string;
  outcome: string;
  sectionId?: string;
  threadId?: string;
  placement?: { projectId: string; environment: unknown; label: string };
  candidates?: unknown[];
};

/** The model answers routing prompts with `answer`; analysis is canned. */
async function setup(
  answer: Record<string, unknown>,
  settings: Record<string, string> = {},
) {
  world = await fakeWorld({
    settings,
    complete: ({ prompt }) =>
      prompt.includes("Someone is starting new work")
        ? JSON.stringify(answer)
        : JSON.stringify({ recap: "r", state: "done", subject: null }),
  });
  const w = world;
  const alpha = w.addSection("Alpha");
  w.addThread("a1", {
    sectionId: alpha.id,
    projectId: "proj_1",
    title: "Alpha task",
  });
  await w.harness.behavior.callRpc("refresh", null);
  return { w, alpha };
}
const route = (w: World, prompt: string, pickedProjectId?: string) =>
  w.harness.behavior.callRpc("route", {
    prompt,
    pickedProjectId,
  }) as Promise<Decision>;
const routePrompts = (w: World) =>
  w.completions.filter((c) =>
    c.prompt.includes("Someone is starting new work"),
  );

describe("route", () => {
  it("places code work in the workstream's primary project checkout", async () => {
    const { w, alpha } = await setup({
      outcome: "new-thread",
      workstream: "alpha",
      title: "Fix the Alpha parser",
      code: true,
      confidence: "high",
      reason: "Alpha parser work",
    });
    const decision = await route(
      w,
      "Fix the parser in Alpha so it handles tabs",
    );
    expect(decision).toMatchObject({
      outcome: "new-thread",
      sectionId: alpha.id,
      placement: {
        projectId: "proj_1",
        environment: {
          type: "host",
          workspace: { type: "unmanaged", path: null },
        },
        label: "checkout",
      },
    });
    const [call] = routePrompts(w);
    expect(call!.prompt).toContain('"Alpha"');
    expect(call!.prompt).not.toContain("Zebracorn");
    expect(call!.prompt).not.toContain("proj_1");
  });

  it("sends work with no code target to a fresh personal workspace, or the home project", async () => {
    const answer = {
      outcome: "new-workstream",
      name: "Trip planning",
      description: "Travel",
      title: "Plan the Lisbon trip",
      code: false,
      confidence: "high",
      reason: "Personal errand",
    };
    const { w } = await setup(answer);
    expect(
      (await route(w, "Plan a three-day trip to Lisbon in May")).placement,
    ).toEqual({
      projectId: "proj_personal",
      environment: {
        type: "host",
        hostId: "host_1",
        workspace: { type: "personal" },
      },
      label: "personal workspace",
    });
    await world!.harness.lifecycle.dispose();
    const home = await setup(answer, { homeProjectId: "proj_home" });
    expect(
      (await route(home.w, "Plan a three-day trip to Lisbon in May")).placement
        ?.projectId,
    ).toBe("proj_home");
  });

  it("turns invented threads and workstreams into unsure", async () => {
    const { w } = await setup({
      outcome: "continue",
      threadId: "thr_invented",
      confidence: "high",
      reason: "?",
    });
    expect((await route(w, "Carry on with the migration please")).outcome).toBe(
      "unsure",
    );
  });

  it("short-circuits on a thread mention without calling the model", async () => {
    const { w } = await setup({
      outcome: "unsure",
      candidates: [],
      reason: "",
    });
    const decision = await route(w, "@thread:a1 also handle CRLF");
    expect(decision).toMatchObject({ outcome: "continue", threadId: "a1" });
    expect(routePrompts(w)).toHaveLength(0);
  });
});

describe("execute", () => {
  it("spawns a filed thread with an explicit environment and journals it", async () => {
    const { w, alpha } = await setup({
      outcome: "new-thread",
      workstream: "Alpha",
      title: "Fix tabs",
      code: true,
      confidence: "high",
      reason: "Alpha parser work",
    });
    const decision = await route(
      w,
      "Fix the parser in Alpha so it handles tabs",
    );
    const result = (await w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt: "Fix the parser in Alpha so it handles tabs",
    })) as { threadId: string };
    const [spawn] = w.spawned;
    expect(spawn).toMatchObject({
      projectId: "proj_1",
      sectionId: alpha.id,
      environment: {
        type: "host",
        workspace: { type: "unmanaged", path: null },
      },
      pluginMetadata: {
        kind: "task",
        filedBy: "router",
        workstreamAtCreation: alpha.id,
      },
    });
    expect(spawn!.environment).not.toEqual({ type: "project-default" });
    const { entries } = (await w.harness.behavior.callRpc("journal", null)) as {
      entries: { action: string; source: string; threads: { id: string }[] }[];
    };
    expect(entries[0]).toMatchObject({ action: "route", source: "router" });
    expect(entries[0]!.threads[0]!.id).toBe(result.threadId);
  });

  it("continues a thread by queueing the message", async () => {
    const { w } = await setup({
      outcome: "continue",
      threadId: "a1",
      confidence: "high",
      reason: "Same task",
    });
    const decision = await route(
      w,
      "Also handle CRLF line endings in that fix",
    );
    await w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt: "Also handle CRLF line endings in that fix",
    });
    expect(w.sent).toEqual([
      expect.objectContaining({ threadId: "a1", mode: "queue-if-active" }),
    ]);
    expect(w.spawned).toHaveLength(0);
  });

  it("creates the workstream first for new-workstream", async () => {
    const { w } = await setup({
      outcome: "new-workstream",
      name: "Gamma",
      description: "Gamma product work.",
      title: "Start Gamma",
      code: true,
      projectLike: "Alpha",
      confidence: "high",
      reason: "New product",
    });
    const decision = await route(w, "Start a new Gamma service next to Alpha");
    await w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt: "Start a new Gamma service next to Alpha",
    });
    const gamma = w.sections.find((s) => s.name === "Gamma")!;
    expect(w.spawned[0]).toMatchObject({
      sectionId: gamma.id,
      projectId: "proj_1",
    });
  });
});

describe("native composer", () => {
  it("files a thread created with a previewed prompt, and always proceeds", async () => {
    const { w, alpha } = await setup({
      outcome: "new-thread",
      workstream: "Alpha",
      title: "Fix tabs",
      code: true,
      confidence: "high",
      reason: "Alpha parser work",
    });
    const prompt = "Fix the parser in Alpha so it handles tabs";
    await route(w, prompt);
    const composed = w.addThread("composed", { createdAt: Date.now() });
    const hook = w.harness.registrations.hooks["message.dispatch"]!;
    const decision = await hook(
      makeMessageDispatchHookContext({
        thread: composed,
        input: { text: prompt },
        parentThreadId: null,
        origin: "app",
      }),
    );
    expect(decision).toEqual({ action: "proceed" });
    await new Promise((r) => setTimeout(r, 20));
    expect(w.threads.get("composed")?.sectionId).toBe(alpha.id);
    // Unrelated sends are untouched.
    const other = w.addThread("other", { createdAt: Date.now() });
    await hook(
      makeMessageDispatchHookContext({
        thread: other,
        input: { text: "something else entirely" },
        origin: "app",
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(w.threads.get("other")?.sectionId).toBeNull();
  });
});

describe("bb workstreams new", () => {
  it("exits 3 with candidates when unsure, and changes nothing", async () => {
    const { w } = await setup({
      outcome: "unsure",
      candidates: [{ threadId: "a1" }, { workstream: "Alpha" }],
      reason: "Could be either",
    });
    const result = await w.harness.behavior.runCli([
      "new",
      "Tweak the Alpha thing",
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("@thread:a1");
    expect(w.spawned).toHaveLength(0);
    expect(w.sent).toHaveLength(0);
  });
});

describe("composer filing guards", () => {
  const answer = {
    outcome: "new-thread",
    workstream: "Alpha",
    title: "Fix tabs",
    code: true,
    confidence: "high",
    reason: "Alpha parser work",
  };
  const prompt = "Fix the parser in Alpha so it handles tabs";

  it("ignores follow-ups and a decision made for different text", async () => {
    const { w } = await setup(answer);
    const decision = await route(w, prompt);
    const hook = w.harness.registrations.hooks["message.dispatch"]!;
    const followUp = w.addThread("followup", { createdAt: Date.now() });
    await hook(
      makeMessageDispatchHookContext({
        thread: followUp,
        input: { text: prompt },
        origin: null,
      }),
    );
    const edited = w.addThread("edited", { createdAt: Date.now() });
    await hook(
      makeMessageDispatchHookContext({
        thread: edited,
        input: { text: `${prompt}, and spaces too` },
        origin: "app",
        experimental_submission: {
          pluginId: "workstreams",
          data: { routeId: decision.id },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(w.threads.get("followup")?.sectionId).toBeNull();
    expect(w.threads.get("edited")?.sectionId).toBeNull();
  });

  it("never files a thread the user filed first", async () => {
    const { w } = await setup(answer);
    const beta = w.addSection("Beta");
    await route(w, prompt);
    const composed = w.addThread("composed", { createdAt: Date.now() });
    const hook = w.harness.registrations.hooks["message.dispatch"]!;
    const context = makeMessageDispatchHookContext({
      thread: composed,
      input: { text: prompt },
      origin: "app",
    });
    // The user files it before the hook's filing runs.
    w.threads.set("composed", { ...composed, sectionId: beta.id });
    await hook(context);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.threads.get("composed")?.sectionId).toBe(beta.id);
  });

  it("forgets dry-run routes, so they file nothing later", async () => {
    const { w } = await setup(answer);
    await w.harness.behavior.runCli(["new", prompt, "--dry-run"]);
    const composed = w.addThread("composed", { createdAt: Date.now() });
    await w.harness.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({
        thread: composed,
        input: { text: prompt },
        origin: "app",
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(w.threads.get("composed")?.sectionId).toBeNull();
  });
});
