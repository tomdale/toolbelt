import { afterEach, describe, expect, it } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld } from "./fake-bb.ts";
import { openDatabase } from "../../src/server/db.ts";
import { CorpusStore } from "../../src/server/corpus.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

type Decision = {
  id: string;
  outcome: string;
  alternative?: unknown;
  sectionId?: string | null;
  threadId?: string;
  placement?: { projectId: string; environment: unknown; label: string };
  candidates?: unknown[];
};

/** The model answers routing prompts with `answer`; analysis is canned. */
async function setup(
  answer: Record<string, unknown>,
  settings: Record<string, string> = {},
) {
  let seededEntityId: string | null = null;
  world = await fakeWorld({
    settings,
    complete: ({ prompt }) => {
      if (prompt.includes("Classify the most specific")) {
        if (answer.name === "Billing" || answer.outcome === "new-workstream") {
          return JSON.stringify({
            subjectId: null,
            proposed: { name: "Billing", description: "Invoices" },
          });
        }
        return JSON.stringify({
          subjectId: seededEntityId,
          proposed: null,
        });
      }
      return prompt.includes("Someone is starting new work")
        ? JSON.stringify(answer)
        : JSON.stringify({ recap: "r", state: "done", subject: null });
    },
  });
  const w = world;
  const alpha = w.addSection("Alpha");
  const corpus = new CorpusStore(openDatabase(w.bb));
  corpus.seed([
    {
      sectionId: alpha.id,
      name: "Alpha",
      description: "Alpha effort",
      aliases: [],
    },
  ]);
  seededEntityId = corpus.list()[0]?.id ?? null;
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
      outcome: "new-thread",
      workstream: "Alpha",
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
    const intent = { action: "new-workstream" };
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt: "Start a new Gamma service next to Alpha",
      intent,
    })) as Decision;
    await w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt: "Start a new Gamma service next to Alpha",
      intent,
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
        experimental_submission: {
          pluginId: "workstreams",
          data: { routeId: (await route(w, prompt)).id },
        },
      }),
    );
    expect(decision).toEqual({ action: "proceed" });
    await new Promise((r) => setTimeout(r, 20));
    expect(w.threads.get("composed")?.sectionId).toBeNull();
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

describe("bb workstreams new removed", () => {
  it("rejects retired new command", async () => {
    const { w } = await setup({
      outcome: "unsure",
      candidates: [{ threadId: "a1" }, { workstream: "Alpha" }],
      reason: "Could be either",
    });
    const result = await w.harness.behavior.runCli([
      "new",
      "Tweak the Alpha thing",
    ]);
    expect(result.exitCode).not.toBe(0);
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

  it("excludes a canceled native preview when dispatch has no submit metadata", async () => {
    const { w } = await setup(answer);
    await w.harness.behavior.callRpc("route", {
      prompt,
      suggest: true,
      nativeComposer: true,
      draftKey: "ignored-draft",
    });
    await w.harness.behavior.callRpc("routeCancel", {
      draftKey: "ignored-draft",
    });
    const composed = w.addThread("ignored", { createdAt: Date.now() });
    await w.harness.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({
        thread: composed,
        input: { text: prompt },
        origin: "app",
        experimental_submission: { pluginId: "workstreams", data: null },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(w.threads.get("ignored")?.sectionId).toBeNull();
  });

  it("does not file an ordinary submission when an active native preview was never canceled", async () => {
    const { w } = await setup(answer);
    await w.harness.behavior.callRpc("route", {
      prompt,
      suggest: true,
      nativeComposer: true,
      draftKey: "active-draft",
    });
    const composed = w.addThread("uncanceled", { createdAt: Date.now() });
    await w.harness.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({
        thread: composed,
        input: { text: prompt },
        origin: "app",
        experimental_submission: null,
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(w.threads.get("uncanceled")?.sectionId).toBeNull();
  });

  it("ignores manual destination sectionId in submission", async () => {
    const { w } = await setup(answer);
    const beta = w.addSection("Beta");
    const composed = w.addThread("manual", { createdAt: Date.now() });
    const hook = w.harness.registrations.hooks["message.dispatch"]!;
    const context = makeMessageDispatchHookContext({
      thread: composed,
      input: { text: "Some unrelated task text" },
      origin: "app",
      experimental_submission: {
        pluginId: "workstreams",
        data: { sectionId: beta.id },
      },
    });
    const result = await hook(context);
    expect(result).toEqual({ action: "proceed" });
    await hook(context);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.threads.get("manual")?.sectionId).toBeNull();
  });

  it("preserves an existing section when submission contains a manual sectionId for an already sorted thread", async () => {
    const { w } = await setup(answer);
    const beta = w.addSection("Beta");
    const gamma = w.addSection("Gamma");
    const composed = w.addThread("already-sorted", {
      createdAt: Date.now(),
      sectionId: gamma.id,
    });
    const hook = w.harness.registrations.hooks["message.dispatch"]!;
    await hook(
      makeMessageDispatchHookContext({
        thread: composed,
        input: { text: "Already in gamma" },
        origin: "app",
        experimental_submission: {
          pluginId: "workstreams",
          data: { sectionId: beta.id },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(w.threads.get("already-sorted")?.sectionId).toBe(gamma.id);
  });

  it("submits identity and does not manually file sectionId", async () => {
    const { w, alpha } = await setup(answer);
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt,
      suggest: true,
      nativeComposer: true,
      draftKey: "accepted-existing",
    })) as { id: string };
    const composed = w.addThread("accepted-existing", {
      createdAt: Date.now(),
    });
    const hook = w.harness.registrations.hooks["message.dispatch"]!;
    const acceptedContext = makeMessageDispatchHookContext({
      thread: composed,
      input: { text: prompt },
      origin: "app",
      experimental_submission: {
        pluginId: "workstreams",
        data: { routeId: decision.id, sectionId: alpha.id },
      },
    });
    await hook(acceptedContext);
    await hook(acceptedContext);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.threads.get("accepted-existing")?.sectionId).toBeNull();
  });

  it("ignores experimental submission from another plugin", async () => {
    const { w, alpha } = await setup(answer);
    const composed = w.addThread("foreign", { createdAt: Date.now() });
    const hook = w.harness.registrations.hooks["message.dispatch"]!;
    await hook(
      makeMessageDispatchHookContext({
        thread: composed,
        input: { text: prompt },
        origin: "app",
        experimental_submission: {
          pluginId: "other-plugin",
          data: { sectionId: alpha.id },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(w.threads.get("foreign")?.sectionId).toBeNull();
  });

  it("rejects retired createWorkstream RPC", async () => {
    const { w } = await setup(answer);
    await expect(
      w.harness.behavior.callRpc("createWorkstream", {
        name: "Billing",
        description: "Invoices",
      }),
    ).rejects.toThrow(/no rpc method "createWorkstream"/);
  });

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

describe("inline intake", () => {
  it("uses the workstream chosen with + even for a prompt naming other work", async () => {
    const { w, alpha } = await setup({
      outcome: "unsure",
      candidates: [],
      reason: "",
    });
    const decision = await w.harness.behavior.callRpc("route", {
      prompt: "Start work on Beta",
      workstreamId: alpha.id,
    });
    expect(decision).toMatchObject({
      outcome: "new-thread",
      sectionId: alpha.id,
    });
    expect(routePrompts(w)).toHaveLength(0);
    await expect(
      w.harness.behavior.callRpc("route", {
        prompt: "Start work on Beta",
        workstreamId: "deleted-workstream",
      }),
    ).rejects.toThrow("no longer exists");
  });

  it("rejects execution for an edited draft and a decision already used", async () => {
    const { w, alpha } = await setup({
      outcome: "unsure",
      candidates: [],
      reason: "",
    });
    const prompt = "Fix the Alpha parser";
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt,
      workstreamId: alpha.id,
    })) as Decision;
    await expect(
      w.harness.behavior.callRpc("routeExecute", {
        decisionId: decision.id,
        prompt: "Different request",
      }),
    ).rejects.toThrow("preview expired");
    expect(w.spawned).toHaveLength(0);
    await w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt,
    });
    await expect(
      w.harness.behavior.callRpc("routeExecute", {
        decisionId: decision.id,
        prompt,
      }),
    ).rejects.toThrow("preview expired");
    expect(w.spawned).toHaveLength(1);
  });

  it("keeps structured composer input when continuing a thread", async () => {
    const { w } = await setup({
      outcome: "continue",
      threadId: "a1",
      confidence: "high",
      reason: "Same task",
    });
    const prompt = "Fix the parser using this example";
    const decision = await route(w, prompt);
    const input = [
      { type: "text", text: prompt, mentions: [] },
      { type: "image", path: "uploads/example.png" },
    ];
    await w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt,
      execution: { input },
    });
    expect(w.sent[0]).toMatchObject({ threadId: "a1", input });
  });

  it("uses the composer's environment override only for the routed project", async () => {
    const { w, alpha } = await setup({
      outcome: "unsure",
      candidates: [],
      reason: "",
    });
    const prompt = "Fix the Alpha parser";
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt,
      workstreamId: alpha.id,
    })) as Decision;
    const environment = { type: "reuse", environmentId: "env_mine" };
    await w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt,
      execution: { projectId: "proj_1", environment },
    });
    expect(w.spawned[0]).toMatchObject({ projectId: "proj_1", environment });
    const next = (await w.harness.behavior.callRpc("route", {
      prompt,
      workstreamId: alpha.id,
    })) as Decision;
    await w.harness.behavior.callRpc("routeExecute", {
      decisionId: next.id,
      prompt,
      execution: { projectId: "proj_other", environment },
    });
    expect(w.spawned[1]).toMatchObject({
      environment: next.placement!.environment,
    });
  });
});

it("honors an explicit project override outside the workstream's project map", async () => {
  const { w, alpha } = await setup({
    outcome: "unsure",
    candidates: [],
    reason: "",
  });
  for (const pickedProjectId of ["proj_other", "proj_personal"]) {
    const decision = await w.harness.behavior.callRpc("route", {
      prompt: "Fix Alpha",
      workstreamId: alpha.id,
      pickedProjectId,
    });
    expect(decision).toMatchObject({
      outcome: "new-thread",
      sectionId: alpha.id,
      placement: { projectId: pickedProjectId },
    });
  }
});

describe("New work continuation suggestions", () => {
  const continueA1 = {
    outcome: "continue",
    threadId: "a1",
    confidence: "high",
    reason: "Same task",
  };
  type Suggested = Decision & { alternative?: Decision };
  const suggest = (w: World, prompt: string, intent: object = {}) =>
    w.harness.behavior.callRpc("route", {
      prompt,
      intent,
      offerNewThread: true,
    }) as Promise<Suggested>;

  it("previews the new thread a continuation would otherwise start", async () => {
    const { w, alpha } = await setup(continueA1);
    const prompt = "Also handle CRLF line endings in that fix";
    const decision = await suggest(w, prompt);
    expect(decision).toMatchObject({
      outcome: "continue",
      threadId: "a1",
      alternative: {
        outcome: "new-thread",
        sectionId: alpha.id,
        placement: { projectId: "proj_1" },
      },
    });
    await w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.alternative!.id,
      prompt,
      intent: {},
    });
    expect(w.sent).toHaveLength(0);
    expect(w.spawned[0]).toMatchObject({
      sectionId: alpha.id,
      projectId: "proj_1",
    });
    // One routing call serves both choices.
    expect(routePrompts(w)).toHaveLength(1);
  });

  it("places the alternative to an unfiled thread in that thread's project", async () => {
    const { w } = await setup({ ...continueA1, threadId: "b1" });
    w.addThread("b1", { projectId: "proj_other", title: "Loose end" });
    await w.harness.behavior.callRpc("refresh", null);
    const decision = await suggest(w, "Keep going on the loose end");
    expect(decision.alternative).toMatchObject({
      outcome: "new-thread",
      sectionId: null,
      placement: { projectId: "proj_other" },
    });
  });

  it("offers an alternative only for inferred continuations the caller asked about", async () => {
    const { w } = await setup(continueA1);
    expect((await route(w, "Also handle CRLF")).alternative).toBeUndefined();
    const mentioned = await suggest(w, "Follow up on @thread:a1");
    expect(mentioned).toMatchObject({ outcome: "continue", threadId: "a1" });
    expect(mentioned.alternative).toMatchObject({ outcome: "new-thread" });
    const fixed = await suggest(w, "Also handle CRLF", {
      action: "send-message",
      destination: { kind: "thread", id: "a1" },
    });
    expect(fixed).toMatchObject({ outcome: "continue", threadId: "a1" });
    expect(fixed.alternative).toBeUndefined();
  });
});

describe("explicit New work intent", () => {
  it("keeps an explicit destination ahead of mentions and classification", async () => {
    const { w, alpha } = await setup({
      outcome: "continue",
      threadId: "a1",
      confidence: "high",
      reason: "model target",
    });
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt: "Continue with @thread:a1 but start a fresh task",
      intent: {
        action: "new-thread",
        destination: { kind: "workstream", id: alpha.id },
      },
    })) as Decision;
    expect(decision).toMatchObject({
      outcome: "new-thread",
      sectionId: alpha.id,
    });
    expect(
      w.completions.filter((c) =>
        c.prompt.includes("Someone is starting new work"),
      ),
    ).toHaveLength(0);
  });

  it("supports a manual destination with automatic action", async () => {
    const { w, alpha } = await setup({
      outcome: "unsure",
      candidates: [],
      reason: "",
    });
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt: "Send this to Alpha",
      intent: { destination: { kind: "workstream", id: alpha.id } },
    })) as Decision;
    expect(decision).toMatchObject({
      outcome: "new-thread",
      sectionId: alpha.id,
    });
  });

  it("creates an explicitly unassigned thread without filing it", async () => {
    const { w } = await setup({
      outcome: "continue",
      threadId: "a1",
      confidence: "high",
      reason: "ignored",
    });
    const prompt = "Write an unassigned checklist";
    const intent = {
      action: "new-thread" as const,
      destination: { kind: "none" as const },
      placement: { projectId: "proj_personal" },
    };
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt,
      intent,
    })) as Decision;
    expect(decision).toMatchObject({
      outcome: "new-thread",
      sectionId: null,
      placement: { projectId: "proj_personal" },
    });
    await w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt,
      intent,
      execution: { input: [{ type: "text", text: prompt, mentions: [] }] },
    });
    expect(w.spawned[0]).toMatchObject({
      sectionId: null,
      pluginMetadata: { unassignedByRouter: true },
    });
    expect(w.threads.get("spawn1")?.sectionId).toBeNull();
  });

  it("rejects a changed intent and permits only one execute", async () => {
    const { w, alpha } = await setup({
      outcome: "unsure",
      candidates: [],
      reason: "",
    });
    const prompt = "Fix Alpha manually";
    const intent = {
      action: "new-thread" as const,
      destination: { kind: "workstream" as const, id: alpha.id },
    };
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt,
      intent,
    })) as Decision;
    await expect(
      w.harness.behavior.callRpc("routeExecute", {
        decisionId: decision.id,
        prompt,
        intent: { ...intent, destination: { kind: "none" } },
      }),
    ).rejects.toThrow("preview changed");
    await w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt,
      intent,
    });
    await expect(
      w.harness.behavior.callRpc("routeExecute", {
        decisionId: decision.id,
        prompt,
        intent,
      }),
    ).rejects.toThrow("preview expired");
    expect(w.spawned).toHaveLength(1);
  });

  it("preserves structured input and validates an explicit thread target", async () => {
    const { w } = await setup({
      outcome: "unsure",
      candidates: [],
      reason: "",
    });
    const prompt = "Send an image to the existing task";
    const input = [
      { type: "text", text: prompt, mentions: [] },
      { type: "image", path: "uploads/x.png" },
    ];
    const intent = {
      action: "send-message" as const,
      destination: { kind: "thread" as const, id: "a1" },
    };
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt,
      intent,
    })) as Decision;
    await w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt,
      intent,
      execution: { input },
    });
    expect(w.sent[0]).toMatchObject({ threadId: "a1", input });
    await expect(
      w.harness.behavior.callRpc("route", {
        prompt,
        intent: { ...intent, destination: { kind: "thread", id: "missing" } },
      }),
    ).rejects.toThrow("no longer exists");
  });

  it("lets an explicit new-workstream action infer its name", async () => {
    const { w } = await setup({
      outcome: "new-workstream",
      name: "Offline sync",
      description: "",
      title: "Sync",
      code: true,
      confidence: "high",
      reason: "new effort",
    });
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt: "Start a spike on offline sync",
      intent: { action: "new-workstream" },
    })) as Decision;
    expect(decision).toMatchObject({
      outcome: "new-workstream",
      name: "Offline sync",
    });
    expect(routePrompts(w)).toHaveLength(1);
  });
});

const rawOutcomes = {
  continue: {
    outcome: "continue",
    threadId: "a1",
    confidence: "high",
    reason: "same task",
  },
  "new-thread": {
    outcome: "new-thread",
    workstream: "Alpha",
    title: "Fix Alpha",
    code: true,
    confidence: "high",
    reason: "Alpha work",
  },
  "new-workstream": {
    outcome: "new-workstream",
    name: "Gamma",
    description: "",
    title: "Start Gamma",
    projectLike: "Alpha",
    code: true,
    confidence: "high",
    reason: "new effort",
  },
  unsure: {
    outcome: "unsure",
    candidates: [{ threadId: "a1" }, { workstream: "Alpha" }],
    reason: "uncertain",
  },
};

describe("New work shipping regressions", () => {
  for (const action of [
    "new-thread",
    "send-message",
    "new-workstream",
  ] as const) {
    for (const [outcome, answer] of Object.entries(rawOutcomes)) {
      it(`constrains ${action} against classifier ${outcome}`, async () => {
        const { w } = await setup(answer);
        const decision = (await w.harness.behavior.callRpc("route", {
          prompt: "Investigate the task",
          intent: { action },
        })) as Decision;
        const allowed = action === "send-message" ? "continue" : action;
        expect([allowed, "unsure"]).toContain(decision.outcome);
        if (decision.outcome === "unsure") {
          for (const candidate of decision.candidates as { kind: string }[]) {
            expect(candidate.kind).toBe(
              action === "send-message"
                ? "thread"
                : action === "new-thread"
                  ? "workstream"
                  : "none",
            );
          }
        }
      });
    }
    for (const mention of ["@thread:a1", "section"]) {
      it(`constrains ${action} against ${mention} shortcut`, async () => {
        const { w, alpha } = await setup(rawOutcomes.continue);
        const decision = (await w.harness.behavior.callRpc("route", {
          prompt: `${mention === "section" ? `@section:${alpha.id}` : mention} investigate`,
          intent: { action },
        })) as Decision;
        expect([
          action === "send-message" ? "continue" : action,
          "unsure",
        ]).toContain(decision.outcome);
      });
    }
  }

  for (const [outcome, answer] of Object.entries(rawOutcomes)) {
    it(`keeps explicit none unassigned for raw ${outcome}, inferring only placement`, async () => {
      const { w } = await setup(answer);
      const decision = await w.harness.behavior.callRpc("route", {
        prompt: "Investigate Alpha",
        intent: { destination: { kind: "none" } },
      });
      expect(decision).toMatchObject({
        outcome: "new-thread",
        sectionId: null,
        workstream: null,
        placement:
          outcome === "new-workstream" ? null : { projectId: "proj_1" },
      });
    });
  }

  it("rejects unresolved unassigned execution without rerouting or side effects", async () => {
    const { w } = await setup(
      { outcome: "unsure", candidates: [], reason: "no evidence" },
      { homeProjectId: "proj_home" },
    );
    const prompt = "Write a checklist";
    const intent = { destination: { kind: "none" } };
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt,
      intent,
    })) as Decision;
    expect(decision).toMatchObject({
      outcome: "new-thread",
      sectionId: null,
      workstream: null,
      placement: null,
    });
    const before = routePrompts(w).length;
    await expect(
      w.harness.behavior.callRpc("routeExecute", {
        decisionId: decision.id,
        prompt,
        intent,
      }),
    ).rejects.toThrow("Choose a project");
    expect(routePrompts(w)).toHaveLength(before);
    expect(w.spawned).toHaveLength(0);
    expect(w.sent).toHaveLength(0);
  });

  it("claims a candidate preview before deferred SDK placement", async () => {
    const { w, alpha } = await setup(rawOutcomes.unsure);
    const prompt = "Investigate Alpha";
    const decision = await route(w, prompt);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.harness.inspection.sdk.stub("projects.list", async () => {
      await blocked;
      return [{ id: "proj_1", name: "Zebracorn", sources: [] }];
    });
    const args = {
      decisionId: decision.id,
      prompt,
      choice: { sectionId: alpha.id },
    };
    const first = w.harness.behavior.callRpc("routeExecute", args);
    const second = w.harness.behavior.callRpc("routeExecute", args);
    const results = Promise.allSettled([first, second]);
    release();
    expect((await results).map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(w.spawned).toHaveLength(1);
  });

  for (const mention of [false, true]) {
    it(`uses environment-only override with ${mention ? "mention" : "classifier"} project inference`, async () => {
      const { w, alpha } = await setup(rawOutcomes["new-thread"]);
      const environment = {
        type: "host",
        hostId: "host_1",
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "named", name: "main" },
        },
      };
      const intent = { placement: { environment } };
      const prompt = mention
        ? `@section:${alpha.id} investigate`
        : "Investigate Alpha";
      const decision = (await w.harness.behavior.callRpc("route", {
        prompt,
        intent,
      })) as Decision;
      expect(decision.placement).toMatchObject({
        projectId: "proj_1",
        environment,
      });
      await w.harness.behavior.callRpc("routeExecute", {
        decisionId: decision.id,
        prompt,
        intent,
      });
      expect(w.spawned[0]).toMatchObject({ environment });
    });
  }

  it("rejects an invalid project and malformed environment at the boundary", async () => {
    const { w, alpha } = await setup(rawOutcomes.unsure);
    await expect(
      w.harness.behavior.callRpc("route", {
        prompt: "Alpha",
        intent: {
          destination: { kind: "workstream", id: alpha.id },
          placement: { projectId: "missing" },
        },
      }),
    ).rejects.toThrow("project");
    await expect(
      w.harness.behavior.callRpc("route", {
        prompt: "Alpha",
        intent: { placement: { environment: { type: "reuse" } } },
      }),
    ).rejects.toThrow();
  });
});

it("reads unassigned metadata on thread.created and suppresses composer refiling", async () => {
  const { w, alpha } = await setup(rawOutcomes["new-thread"]);
  const prompt = "Investigate Alpha";
  await route(w, prompt);
  w.harness.inspection.sdk.stub(
    "threads.getPluginMetadata",
    async ({ threadId }: { threadId: string }) =>
      threadId === "unassigned-event" ? { unassignedByRouter: true } : {},
  );
  const thread = w.addThread("unassigned-event", { createdAt: Date.now() });
  await w.harness.behavior.emitThreadEvent("thread.created", { thread });
  const hook = w.harness.registrations.hooks["message.dispatch"]!;
  await hook(
    makeMessageDispatchHookContext({
      thread,
      input: { text: prompt },
      origin: "plugin",
    }),
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(w.threads.get(thread.id)?.sectionId).toBeNull();
  expect(w.threads.get(thread.id)?.sectionId).not.toBe(alpha.id);
});

for (const [name, target] of [
  [
    "another project",
    {
      projectId: "proj_other",
      status: "ready",
      hostLifecycle: "active",
      lifecycle: { phase: "active" },
    },
  ],
  [
    "destroyed",
    {
      projectId: "proj_1",
      status: "destroyed",
      hostLifecycle: "active",
      lifecycle: { phase: "destroyed" },
    },
  ],
  [
    "offline lifecycle",
    {
      projectId: "proj_1",
      status: "ready",
      hostLifecycle: "removed",
      lifecycle: { phase: "active" },
    },
  ],
] as const) {
  it(`rejects reuse environment from ${name} before any creation`, async () => {
    const { w, alpha } = await setup(rawOutcomes.unsure);
    w.harness.inspection.sdk.stub("environments.get", async () => target);
    await expect(
      w.harness.behavior.callRpc("route", {
        prompt: "Alpha",
        intent: {
          destination: { kind: "workstream", id: alpha.id },
          placement: {
            environment: { type: "reuse", environmentId: "env_wrong" },
          },
        },
      }),
    ).rejects.toThrow(/another project|unavailable/);
    expect(w.spawned).toHaveLength(0);
  });
}

it("requires agreeing project evidence across all unassigned candidates", async () => {
  const { w } = await setup(
    {
      outcome: "unsure",
      candidates: [{ workstream: "Alpha" }, { workstream: "Beta" }],
      reason: "both fit",
    },
    { homeProjectId: "proj_home" },
  );
  const beta = w.addSection("Beta");
  w.addThread("b1", {
    sectionId: beta.id,
    projectId: "proj_other",
    title: "Beta task",
  });
  await w.harness.behavior.callRpc("refresh", null);
  const decision = await w.harness.behavior.callRpc("route", {
    prompt: "Investigate the shared task",
    intent: { destination: { kind: "none" } },
  });
  expect(decision).toMatchObject({
    outcome: "new-thread",
    sectionId: null,
    workstream: null,
    placement: null,
  });
});

it("rejects contradictory explicit action and destination", async () => {
  const { w, alpha } = await setup(rawOutcomes["new-thread"]);
  for (const intent of [
    { action: "new-thread", destination: { kind: "thread", id: "a1" } },
    {
      action: "send-message",
      destination: { kind: "workstream", id: alpha.id },
    },
    {
      action: "new-workstream",
      destination: { kind: "workstream", id: alpha.id },
    },
  ])
    await expect(
      w.harness.behavior.callRpc("route", {
        prompt: "Investigate Alpha",
        intent,
      }),
    ).rejects.toThrow("incompatible");
  expect(routePrompts(w)).toHaveLength(0);
});

it("claims concurrent sends once and preserves attachments and mentions", async () => {
  const { w } = await setup(rawOutcomes.continue);
  const prompt = "Investigate the attached example";
  const intent = {
    action: "send-message",
    destination: { kind: "thread", id: "a1" },
  };
  const decision = (await w.harness.behavior.callRpc("route", {
    prompt,
    intent,
  })) as Decision;
  const input = [
    { type: "text", text: prompt, mentions: [{ kind: "thread", id: "a1" }] },
    { type: "image", path: "uploads/example.png" },
  ];
  let release!: () => void;
  const block = new Promise<void>((r) => {
    release = r;
  });
  w.harness.inspection.sdk.stub("threads.get", async () => {
    await block;
    return w.threads.get("a1")!;
  });
  const args = {
    decisionId: decision.id,
    prompt,
    intent,
    execution: { input },
  };
  const results = Promise.allSettled([
    w.harness.behavior.callRpc("routeExecute", args),
    w.harness.behavior.callRpc("routeExecute", args),
  ]);
  release();
  expect((await results).map((r) => r.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]).toMatchObject({ threadId: "a1", input });
});

it("preserves attachments and mentions when spawning with a same-project override", async () => {
  const { w } = await setup(rawOutcomes["new-thread"]);
  const prompt = "Investigate the attachment";
  const environment = { type: "reuse", environmentId: "env_mine" };
  const intent = { placement: { projectId: "proj_1", environment } };
  const input = [
    { type: "text", text: prompt, mentions: [{ kind: "thread", id: "a1" }] },
    { type: "localFile", path: "uploads/example.txt", mimeType: "text/plain" },
  ];
  const decision = (await w.harness.behavior.callRpc("route", {
    prompt,
    intent,
  })) as Decision;
  await w.harness.behavior.callRpc("routeExecute", {
    decisionId: decision.id,
    prompt,
    intent,
    execution: { input },
  });
  expect(w.spawned).toHaveLength(1);
  expect(w.spawned[0]).toMatchObject({
    input,
    environment,
    projectId: "proj_1",
  });
});

it("validates a candidate intent snapshot before placement work", async () => {
  const { w, alpha } = await setup(rawOutcomes.unsure);
  const prompt = "Investigate Alpha";
  const intent = {
    action: "new-thread",
    placement: { projectId: "proj_other" },
  };
  const decision = (await w.harness.behavior.callRpc("route", {
    prompt,
    intent,
  })) as Decision;
  w.harness.inspection.sdk.stub("projects.list", async () => {
    throw new Error("Placement started before validating intent");
  });
  await expect(
    w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt,
      choice: { sectionId: alpha.id },
      intent: { ...intent, placement: { projectId: "proj_1" } },
    }),
  ).rejects.toThrow("preview changed");
  w.harness.inspection.sdk.stub("projects.list", async () => [
    { id: "proj_other", name: "Other", sources: [] },
  ]);
  await w.harness.behavior.callRpc("routeExecute", {
    decisionId: decision.id,
    prompt,
    choice: { sectionId: alpha.id },
    intent,
  });
  expect(w.spawned).toHaveLength(1);
  expect(w.spawned[0]).toMatchObject({
    projectId: "proj_other",
    sectionId: alpha.id,
  });
});

it("rejects unresolved new-workstream execution without rerouting", async () => {
  const { w } = await setup(rawOutcomes.continue, {
    homeProjectId: "proj_home",
  });
  const prompt = "Create Gamma";
  const intent = { action: "new-workstream", workstreamName: "Gamma" };
  const decision = (await w.harness.behavior.callRpc("route", {
    prompt,
    intent,
  })) as Decision;
  expect(decision).toMatchObject({
    outcome: "new-workstream",
    placement: null,
  });
  await expect(
    w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt,
      intent,
    }),
  ).rejects.toThrow("Choose a project");
  expect(routePrompts(w)).toHaveLength(0);
  expect(w.spawned).toHaveLength(0);
  expect(w.sections.some((s) => s.name === "Gamma")).toBe(false);
});

it("revalidates reuse availability before creating a workstream", async () => {
  const { w } = await setup(rawOutcomes.unsure);
  const prompt = "Create Gamma";
  const intent = {
    action: "new-workstream",
    workstreamName: "Gamma",
    placement: {
      projectId: "proj_1",
      environment: { type: "reuse", environmentId: "env_mine" },
    },
  };
  const decision = (await w.harness.behavior.callRpc("route", {
    prompt,
    intent,
  })) as Decision;
  w.harness.inspection.sdk.stub("environments.get", async () => ({
    projectId: "proj_1",
    status: "destroyed",
    hostLifecycle: "active",
    lifecycle: { phase: "destroyed" },
  }));
  await expect(
    w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt,
      intent,
    }),
  ).rejects.toThrow("unavailable");
  expect(w.spawned).toHaveLength(0);
  expect(w.sections.some((s) => s.name === "Gamma")).toBe(false);
});

it("validates execution environments and prevents replacing explicit placement", async () => {
  const { w, alpha } = await setup(rawOutcomes.unsure);
  const prompt = "Alpha task";
  const intent = {
    destination: { kind: "workstream", id: alpha.id },
    placement: { environment: { type: "reuse", environmentId: "env_mine" } },
  };
  const decision = (await w.harness.behavior.callRpc("route", {
    prompt,
    intent,
  })) as Decision;
  await expect(
    w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt,
      intent,
      execution: { projectId: "proj_1", environment: { type: "unrecognized" } },
    }),
  ).rejects.toThrow();
  await expect(
    w.harness.behavior.callRpc("routeExecute", {
      decisionId: decision.id,
      prompt,
      intent,
      execution: {
        projectId: "proj_1",
        environment: { type: "reuse", environmentId: "env_changed" },
      },
    }),
  ).rejects.toThrow("preview changed");
  expect(w.spawned).toHaveLength(0);
});

it("rejects retired new command with workstream option", async () => {
  const { w, alpha } = await setup(rawOutcomes.continue);
  const prompt = "A fresh Alpha task";
  const result = await w.harness.behavior.runCli([
    "new",
    prompt,
    "--workstream",
    "Alpha",
    "--json",
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(w.spawned).toHaveLength(0);
});

for (const mention of ["@thread:a1", "@section:sec_1"]) {
  it(`keeps explicit none ahead of ${mention}`, async () => {
    const { w } = await setup(rawOutcomes.continue);
    const decision = await w.harness.behavior.callRpc("route", {
      prompt: `${mention} new task`,
      intent: { destination: { kind: "none" } },
    });
    expect(decision).toMatchObject({
      outcome: "new-thread",
      sectionId: null,
      workstream: null,
      placement: { projectId: "proj_1" },
    });
  });
}

it("an inferred novel home stays unsure even with an independent name override", async () => {
  const { w } = await setup(rawOutcomes["new-workstream"]);
  const prompt = "Start a new effort alongside Alpha";
  const intent = { workstreamName: "Chosen effort" };
  const decision = (await w.harness.behavior.callRpc("route", {
    prompt,
    intent,
  })) as Decision;
  expect(decision).toMatchObject({ outcome: "unsure" });
  expect(w.sections.map((s) => s.name)).toEqual(["Alpha"]);
  expect(w.spawned).toHaveLength(0);
});

it("an independent name override leaves other inferred actions unchanged", async () => {
  const { w } = await setup(rawOutcomes.continue);
  const prompt = "Continue the same effort";
  const intent = { workstreamName: "Chosen effort" };
  const decision = (await w.harness.behavior.callRpc("route", {
    prompt,
    intent,
  })) as Decision;
  expect(decision).toMatchObject({ outcome: "continue", threadId: "a1" });
  await w.harness.behavior.callRpc("routeExecute", {
    decisionId: decision.id,
    prompt,
    intent,
  });
  expect(w.sent).toHaveLength(1);
  expect(w.spawned).toHaveLength(0);
  expect(w.sections.some((s) => s.name === "Chosen effort")).toBe(false);
});
