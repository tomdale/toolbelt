import { afterEach, describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld } from "./fake-bb.ts";
import { instructionsFor, quote } from "../../src/domain/instructions.ts";
import { WORKER_THREAD_MARKER } from "../../src/domain/worker.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

describe("instructions", () => {
  it("guides delegation by project shape", () => {
    const task = (shape: "git" | "workforest" | "none") =>
      instructionsFor({
        kind: "task",
        workstream: { name: "Alpha", description: "Alpha product work." },
        shape,
      });
    expect(task("git")).toContain(
      "`--new-environment worktree` for code changes",
    );
    expect(task("workforest")).toContain("wf task new <slug> --repo <repo>");
    expect(task("workforest")).toContain("BB worktrees are unavailable");
    expect(task("none")).toContain("`--new-environment personal`");
    expect(task("git")).toContain(
      'bb thread spawn --parent-self --lifecycle-owner-thread "$BB_THREAD_ID"',
    );
    expect(task("git")).toContain("bb workstreams handoff --request-stdin");
    expect(task("git").length).toBeLessThanOrEqual(4096);
  });

  it("keeps delegates from delegating", () => {
    const text = instructionsFor({ kind: "delegate", parentTitle: "Fix tabs" });
    expect(text).toContain('delegated subtask of "Fix tabs"');
    expect(text).toContain("Report results and scope questions to it");
    expect(text).toContain(
      "Your parent coordinates ownership and further delegation",
    );
    expect(text).toContain(
      "ask it before spawning further threads or transferring ownership",
    );
    expect(text).not.toContain("bb workstreams handoff");
  });

  it("retains direct requests regardless of organizational placement or workspace shape", () => {
    for (const shape of ["git", "workforest", "none", "unknown"] as const) {
      for (const workstream of [
        null,
        { name: "Alpha", description: "Alpha work" },
      ]) {
        const text = instructionsFor({ kind: "task", workstream, shape });
        expect(text).toContain("Continue the user's requests here");
        expect(text).toContain(
          "resolve repository or environment setup as part of the task",
        );
        expect(text).toContain(
          "only when the user explicitly requests or approves that transfer",
        );
        expect(text).toContain("share the returned thread link with the user");
        expect(text).toContain(
          "Keep coordination lightweight so it does not delay the requested work",
        );
        expect(text).toContain("at most one bounded metadata lookup");
        expect(text).toContain(
          "ordinary requests need no other-thread investigation",
        );
        expect(text).not.toContain("don't do it here");
        expect(text.length).toBeLessThanOrEqual(4096);
      }
    }
  });

  it("strips markup and shell syntax from names", () => {
    expect(quote("Evil `rm -rf` $(x) **bold**\nnext")).toBe(
      "Evil rm -rf (x) bold next",
    );
  });
});

describe("configure", () => {
  async function setup() {
    world = await fakeWorld();
    const w = world;
    const alpha = w.addSection("Alpha");
    w.addThread("task", { sectionId: alpha.id, title: "Fix tabs" });
    w.addThread("kid", { parentThreadId: "task", title: "Write test" });
    await w.harness.behavior.callRpc("refresh", null);
    return w;
  }
  const resolve = (
    w: World,
    thread: { id: string; parentThreadId?: string | null },
    extra: Parameters<typeof makePluginAgentConfigurationContext>[0] = {},
  ) =>
    w.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        ...extra,
        thread: { parentThreadId: null, ...thread, ...extra.thread },
      }),
    );

  it("gives task threads their workstream and delegates their parent, with the recap tool", async () => {
    const w = await setup();
    const task = await resolve(w, { id: "task" });
    expect(task.instructions).toContain(
      'task thread in the "Alpha" workstream',
    );
    expect(task.tools.map((tool) => tool.name)).toEqual([
      "WorkstreamsRecap",
      "AskUserQuestion",
    ]);
    expect(task.instructions).toContain("End every turn with WorkstreamsRecap");
    const kid = await resolve(w, { id: "kid", parentThreadId: "task" });
    expect(kid.instructions).toContain('delegated subtask of "Fix tabs"');
  });

  it("keeps worker threads out of recap enrollment and role instructions", async () => {
    const w = await setup();
    const worker = await resolve(
      w,
      { id: "worker" },
      {
        pluginMetadata: {
          [WORKER_THREAD_MARKER.key]: WORKER_THREAD_MARKER.value,
          kind: "task",
          filedSectionId: w.sections[0]!.id,
          filedAt: Date.now(),
        },
      },
    );
    expect(worker.instructions).toBeNull();
    expect(worker.tools).toEqual([]);
    expect(
      w.bb.storage
        .database()
        .prepare("SELECT thread_id FROM ws_agent_recap WHERE thread_id = ?")
        .get("worker"),
    ).toBeUndefined();

    const normal = await resolve(w, { id: "ordinary" });
    expect(normal.tools.map((tool) => tool.name)).toEqual([
      "WorkstreamsRecap",
      "AskUserQuestion",
    ]);
    expect(normal.instructions).toContain(
      "End every turn with WorkstreamsRecap",
    );
  });

  it("stays out of side chats, and gives unknown threads only the recap", async () => {
    const w = await setup();
    const side = await resolve(
      w,
      { id: "task" },
      {
        origin: { kind: "fork", pluginId: "side-chat" },
      },
    );
    // Side chats can still ask questions, but get no role or recap.
    expect(side.instructions).not.toContain("WorkstreamsRecap");
    expect(side.tools.map((tool) => tool.name)).toEqual(["AskUserQuestion"]);
    // A thread with no role yet still ends its turns with a recap.
    const unknown = await resolve(w, { id: "hidden-helper" });
    expect(unknown.instructions).not.toContain("workstream");
    expect(unknown.instructions).toContain("WorkstreamsRecap");
    expect(unknown.instructions).toContain(
      "Include one to three relevant next actions whenever the user can take or request one",
    );
  });

  it("trusts task metadata for a thread the reconciler hasn't seen yet", async () => {
    const w = await setup();
    const fresh = await resolve(
      w,
      { id: "brand-new" },
      {
        pluginMetadata: {
          kind: "task",
          filedSectionId: w.sections[0]!.id,
          filedAt: Date.now(),
        },
      },
    );
    expect(fresh.instructions).toContain('"Alpha" workstream');
    // Stale task metadata on an unseen thread (a hidden fork's copy) is ignored.
    const copy = await resolve(
      w,
      { id: "hidden-fork" },
      {
        pluginMetadata: {
          kind: "task",
          filedSectionId: w.sections[0]!.id,
          filedAt: Date.now() - 60 * 60_000,
        },
      },
    );
    expect(copy.instructions).not.toContain("Alpha");
  });
});

describe("bb workstreams handoff", () => {
  const answer = {
    outcome: "new-thread",
    workstream: "Alpha",
    title: "Other work",
    code: true,
    confidence: "high",
    reason: "Belongs in Alpha",
  };
  async function setup(callerFiled = true) {
    world = await fakeWorld({
      complete: ({ prompt }) =>
        prompt.includes("Someone is starting new work")
          ? JSON.stringify(answer)
          : JSON.stringify({ recap: "r", state: "done" }),
    });
    const w = world;
    const alpha = w.addSection("Alpha");
    w.addThread("caller", {
      sectionId: callerFiled ? alpha.id : null,
      projectId: "proj_1",
    });
    if (!callerFiled) w.addThread("alpha-peer", { sectionId: alpha.id });
    await w.harness.behavior.callRpc("refresh", null);
    return w;
  }
  const handoff = (w: World, request: string, args: string[] = []) =>
    w.harness.behavior.runCli(
      ["handoff", "--request", request, ...args, "--json"],
      { threadId: "caller" },
    );

  it("starts a labeled thread spawned from the caller, with bounded output", async () => {
    const w = await setup();
    const result = await handoff(w, "Please also redo the landing page copy");
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(Object.keys(out).sort()).toEqual(
      ["link", "outcome", "reason", "threadId", "workstream"].sort(),
    );
    expect(out).toMatchObject({ outcome: "new-thread", workstream: "Alpha" });
    const [spawn] = w.spawned;
    expect(spawn!.prompt).toMatch(/^Handed off from @thread:caller\. /);
    expect(spawn!.pluginMetadata).toMatchObject({
      spawnedFrom: "caller",
      filedBy: "handoff",
    });
    expect(spawn!.parentThreadId).toBeUndefined();
  });

  it("consumes the dispatch instruction while preserving the task and execution preferences", async () => {
    const w = await setup();
    const request =
      "Start a new thread using the selected model at high effort, then fix the parser error";
    const result = await handoff(w, request);
    expect(result.exitCode).toBe(0);
    const prompt = w.spawned[0]!.prompt;
    expect(prompt).toContain("You own this task and the user continues here");
    expect(prompt).toContain(
      "fulfills any instruction in the original request to start or move the work into another thread",
    );
    expect(prompt).toContain(
      "Carry out the remaining task here, retaining its execution preferences",
    );
    expect(prompt).toContain(
      "Resolve repository or environment setup as part of the task",
    );
    expect(prompt).toContain(
      "only with a further explicit user request or approval",
    );
    expect(prompt).toContain(
      `Original user request (preserved verbatim):\n${request}`,
    );
    expect(w.spawned).toHaveLength(1);
  });

  it("keeps handoff threads in the caller's workstream", async () => {
    world = await fakeWorld({
      complete: ({ prompt }) =>
        prompt.includes("Someone is starting new work")
          ? JSON.stringify({ ...answer, workstream: "Beta" })
          : JSON.stringify({ recap: "r", state: "done" }),
    });
    const w = world;
    const alpha = w.addSection("Alpha");
    w.addSection("Beta");
    w.addThread("caller", { sectionId: alpha.id, projectId: "proj_1" });
    await w.harness.behavior.callRpc("refresh", null);

    const result = await handoff(w, "Please redo the landing page copy");

    expect(result.exitCode).toBe(0);
    expect(w.spawned[0]).toMatchObject({ sectionId: alpha.id });
    expect(w.spawned[0]?.pluginMetadata).toMatchObject({
      filedBy: "handoff",
      filedSectionId: alpha.id,
    });
    expect(
      w.completions.some((call) =>
        call.prompt.includes("Someone is starting new work"),
      ),
    ).toBe(false);
  });

  it("never offers the caller as a target and stops after three per turn", async () => {
    const w = await setup(false);
    for (let i = 0; i < 3; i++)
      expect((await handoff(w, `Separate request number ${i}`)).exitCode).toBe(
        0,
      );
    const route = w.completions.find((c) =>
      c.prompt.includes("Someone is starting new work"),
    )!;
    expect(route.prompt).not.toContain('id "caller"');
    const fourth = await handoff(w, "One more separate request");
    expect(fourth.exitCode).not.toBe(0);
    expect(fourth.stderr + fourth.stdout).toMatch(/already handed off 3/);
    // The next turn gets three more.
    w.threads.set("caller", {
      ...w.threads.get("caller")!,
      latestAttentionAt: Date.now() + 1000,
    });
    expect((await handoff(w, "A request in the next turn")).exitCode).toBe(0);
  });

  it("doesn't bounce a handed-off request back to where it came from", async () => {
    const w = await setup(false);
    w.addThread("origin", { sectionId: w.sections[0]!.id });
    await w.harness.behavior.callRpc("refresh", null);
    w.harness.sdk.stub("threads.getPluginMetadata", async () => ({
      spawnedFrom: "origin",
    }));
    await handoff(w, "Please also redo the landing page copy");
    const route = w.completions.find((c) =>
      c.prompt.includes("Someone is starting new work"),
    )!;
    expect(route.prompt).not.toContain('id "origin"');
    expect(route.prompt).not.toContain('id "caller"');
  });

  it("previews without acting on --dry-run", async () => {
    const w = await setup();
    const result = await handoff(w, "Redo the landing page copy", [
      "--dry-run",
    ]);
    expect(result.exitCode).toBe(0);
    expect(w.spawned).toHaveLength(0);
  });
});

describe("drift flag", () => {
  async function setup() {
    world = await fakeWorld({
      complete: ({ prompt }) =>
        prompt.includes("You describe one agent thread")
          ? JSON.stringify({
              recap: "Now building a markdown viewer.",
              state: "in_progress",
              subject: "Viewer",
              drift: { workstream: "Beta", newName: null, confidence: "high" },
            })
          : JSON.stringify({ descriptions: {} }),
    });
    const w = world;
    const alpha = w.addSection("Alpha");
    const beta = w.addSection("Beta");
    w.addThread("t1", { sectionId: alpha.id });
    w.addThread("b1", { sectionId: beta.id });
    w.converse("t1", ["Unrelated: build me a markdown viewer"]);
    await w.harness.behavior.callRpc("refresh", null);
    await w.harness.behavior.runCli(["analyze", "t1"]);
    return { w, alpha, beta };
  }

  it("moves the thread to the drift target on Move", async () => {
    const { w, beta } = await setup();
    await w.harness.behavior.callRpc("drift", {
      threadId: "t1",
      action: "move",
    });
    expect(w.threads.get("t1")?.sectionId).toBe(beta.id);
  });

  it("hides the flag on Dismiss", async () => {
    const { w, beta } = await setup();
    await w.harness.behavior.callRpc("drift", {
      threadId: "t1",
      action: "dismiss",
    });
    const state = (await w.harness.behavior.callRpc("state", null)) as {
      driftDismissed: Record<string, string>;
    };
    expect(state.driftDismissed.t1).toBe(beta.id);
  });
});
