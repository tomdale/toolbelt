/**
 * New work's server side: a suggestion names one likely home (possibly a new
 * workstream) and keeps nothing to execute; accepting or ignoring it goes
 * through `startThread`, `sendToThread` and `createWorkstream`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld } from "./fake-bb.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

async function setup(
  answer: Record<string, unknown>,
  settings: Record<string, string | boolean> = {},
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

const suggest = (w: World, prompt: string) =>
  w.harness.behavior.callRpc("route", {
    prompt,
    suggest: true,
    draftKey: "draft-1",
  }) as Promise<Record<string, unknown>>;
const routePrompt = (w: World) =>
  w.completions.find((c) => c.prompt.includes("Someone is starting new work"))!
    .prompt;
const journal = async (w: World) =>
  (
    (await w.harness.behavior.callRpc("journal", null)) as {
      entries: {
        action: string;
        source: string;
        rationale: string;
        threads: { id: string }[];
      }[];
    }
  ).entries;

describe("suggest", () => {
  it("lets the model propose a new workstream with a placement", async () => {
    const { w } = await setup({
      outcome: "new-workstream",
      name: "Billing",
      description: "Invoices and payment flows",
      title: "Add invoice export",
      code: true,
      projectLike: "Alpha",
      confidence: "medium",
      reason: "Nothing covers billing yet",
    });
    const decision = await suggest(w, "Add CSV export for invoices");
    expect(decision).toMatchObject({
      outcome: "new-workstream",
      name: "Billing",
      description: "Invoices and payment flows",
      placement: { projectId: "proj_1" },
    });
    const prompt = routePrompt(w);
    expect(prompt).toContain("Suggest the single most likely home");
    expect(prompt).toContain('"outcome": "new-workstream"');
    expect(w.sections.map((s) => s.name)).toEqual(["Alpha"]);
  });

  it("leaves the project alone for a new code effort with no related workstream", async () => {
    const { w } = await setup({
      outcome: "new-workstream",
      name: "Billing",
      description: "Invoices",
      title: "Add invoice export",
      code: true,
      projectLike: null,
      confidence: "medium",
      reason: "New effort",
    });
    expect(await suggest(w, "Add CSV export for invoices")).toMatchObject({
      outcome: "new-workstream",
      placement: null,
    });
  });

  it("offers empty workstreams, so it doesn't propose duplicates", async () => {
    const { w } = await setup({
      outcome: "new-thread",
      workstream: "Billing",
      title: "Invoice export",
      code: true,
      confidence: "high",
      reason: "Billing",
    });
    const { sectionId } = (await w.harness.behavior.callRpc(
      "createWorkstream",
      { name: "Billing" },
    )) as { sectionId: string };
    // Code work with no project evidence leaves the project alone.
    expect(await suggest(w, "Add CSV export for invoices")).toMatchObject({
      outcome: "new-thread",
      sectionId,
      placement: null,
    });
    expect(routePrompt(w)).toContain('"Billing"');
  });

  it("asks the model to prefer the workstream the field shows", async () => {
    const { w, alpha } = await setup({
      outcome: "new-thread",
      workstream: "Alpha",
      title: "Parser fix",
      code: true,
      confidence: "high",
      reason: "Selected and fits",
    });
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt: "Fix the parser",
      selectedWorkstreamId: alpha.id,
      suggest: true,
    })) as Record<string, unknown>;
    // Unlike `workstreamId`, the selection doesn't skip the model.
    expect(decision).toMatchObject({
      outcome: "new-thread",
      sectionId: alpha.id,
    });
    expect(routePrompt(w)).toContain(
      'The user has already selected the workstream "Alpha" for this work.',
    );
  });

  it("keeps the default classifier from proposing new workstreams", async () => {
    const { w } = await setup({
      outcome: "new-workstream",
      name: "Billing",
      title: "Add invoice export",
    });
    const decision = (await w.harness.behavior.callRpc("route", {
      prompt: "Add CSV export for invoices",
    })) as Record<string, unknown>;
    expect(decision.outcome).toBe("unsure");
    expect(routePrompt(w)).not.toContain("Suggest the single most likely home");
  });

  it("turns an unsure answer into its likeliest candidate", async () => {
    const { w, alpha } = await setup({
      outcome: "unsure",
      candidates: [{ workstream: "Alpha" }, { threadId: "a1" }],
      reason: "Could be either",
    });
    expect(await suggest(w, "Tidy up the parser")).toMatchObject({
      outcome: "new-thread",
      sectionId: alpha.id,
      workstream: "Alpha",
      confidence: "low",
      placement: { projectId: "proj_1" },
    });
  });

  it("turns an unsure thread candidate into a new thread in its workstream", async () => {
    const { w, alpha } = await setup({
      outcome: "unsure",
      candidates: [{ threadId: "a1" }],
      reason: "Probably the same task",
    });
    const decision = await suggest(w, "One more tweak");
    expect(decision).toMatchObject({
      outcome: "new-thread",
      sectionId: alpha.id,
      workstream: "Alpha",
      confidence: "low",
      placement: { projectId: "proj_1" },
    });
    expect(decision).not.toHaveProperty("threadId");
  });

  it.each(["medium", "low"])(
    "suggests a new thread for a %s-confidence continuation",
    async (confidence) => {
      const { w, alpha } = await setup({
        outcome: "continue",
        threadId: "a1",
        confidence,
        reason: "Related to Alpha",
      });
      expect(await suggest(w, "Improve Alpha")).toMatchObject({
        outcome: "new-thread",
        sectionId: alpha.id,
        workstream: "Alpha",
        confidence,
        placement: { projectId: "proj_1" },
      });
      expect(routePrompt(w)).toContain(
        "When it is ambiguous whether this is a new task or a continuation, always prefer a new thread over continuing an existing thread",
      );
    },
  );

  it("preserves a high-confidence task continuation", async () => {
    const { w } = await setup({
      outcome: "continue",
      threadId: "a1",
      confidence: "high",
      reason: "Explicit follow-up",
    });
    expect(
      await suggest(w, "Fix the bug in the Alpha task you just did"),
    ).toMatchObject({
      outcome: "continue",
      threadId: "a1",
      confidence: "high",
    });
  });

  it("suggests an unfiled new thread for an uncertain unfiled continuation", async () => {
    const { w } = await setup({
      outcome: "continue",
      threadId: "unfiled",
      confidence: "low",
      reason: "Possibly related",
    });
    w.addThread("unfiled", { title: "Unfiled task", projectId: "proj_1" });
    await w.harness.behavior.callRpc("refresh", null);
    expect(await suggest(w, "Improve that task")).toMatchObject({
      outcome: "new-thread",
      sectionId: null,
      workstream: null,
      placement: null,
    });
  });

  it("keeps nothing a native composer thread could be filed by", async () => {
    const { w, alpha } = await setup({
      outcome: "new-thread",
      workstream: "Alpha",
      title: "Parser work",
      code: true,
      confidence: "high",
      reason: "Alpha",
    });
    const prompt = "Fix the parser in Alpha";
    const decision = await suggest(w, prompt);
    expect(decision).toMatchObject({ sectionId: alpha.id });
    await expect(
      w.harness.behavior.callRpc("routeExecute", {
        decisionId: decision.id as string,
        prompt,
      }),
    ).rejects.toThrow(/expired/);

    const composed = w.addThread("native", { createdAt: Date.now() });
    const hook = w.harness.registrations.hooks["message.dispatch"]!;
    await hook(
      makeMessageDispatchHookContext({
        thread: composed,
        input: { text: prompt },
        parentThreadId: null,
        origin: "app",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.threads.get("native")?.sectionId).toBeNull();
  });
});

describe("Debug mode", () => {
  const answer = {
    outcome: "unsure",
    candidates: [{ workstream: "Alpha" }],
    reason: "Could be Alpha",
  };

  it("explains each step from the draft to the suggestion", async () => {
    const { w } = await setup(answer, { debug: true });
    const decision = await suggest(w, "Tidy up the parser");
    expect(decision.traceId).toEqual(expect.any(String));
    const { notes, durationMs } = decision.explanation as {
      notes: string[];
      durationMs: number;
    };
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(notes).toEqual([
      "The model answered unsure, with 1 candidate.",
      "The model was unsure among 1 candidate; suggesting the first, which it lists as the likeliest.",
      `Code work goes to "Alpha"'s primary project (where most of its threads run), in its checkout.`,
    ]);
  });

  it("explains a mention without asking the model", async () => {
    const { w } = await setup(answer, { debug: true });
    const decision = await suggest(w, "Follow up in @thread:a1");
    expect(decision).toMatchObject({ outcome: "continue", threadId: "a1" });
    expect((decision.explanation as { notes: string[] }).notes).toEqual([
      `The draft mentions the thread "Alpha task", so the model wasn't asked.`,
    ]);
  });

  it("adds nothing while Debug mode is off", async () => {
    const { w } = await setup(answer);
    expect(await suggest(w, "Tidy up the parser")).not.toHaveProperty(
      "explanation",
    );
  });
});

describe("startThread", () => {
  const execution = {
    projectId: "proj_1",
    environment: {
      type: "host",
      hostId: "host_1",
      workspace: { type: "unmanaged", path: null },
    },
    providerId: "codex",
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "auto",
    executionInputSources: {},
    input: [{ type: "text", text: "Fix the parser", mentions: [] }],
  };

  it("spawns the composer's request in the chosen workstream", async () => {
    const { w, alpha } = await setup({});
    const result = await w.harness.behavior.callRpc("startThread", {
      sectionId: alpha.id,
      execution: { ...execution, unexpected: "dropped" },
    });
    expect(result).toEqual({ threadId: "spawn1", sectionId: alpha.id });
    expect(w.spawned[0]).toMatchObject({
      ...execution,
      sectionId: alpha.id,
      pluginMetadata: {
        kind: "task",
        filedBy: "user",
        workstreamAtCreation: alpha.id,
      },
    });
    expect(w.spawned[0]).not.toHaveProperty("unexpected");
    const [entry] = await journal(w);
    expect(entry).toMatchObject({
      action: "route",
      source: "user",
      rationale: "Started in Alpha from New work",
      threads: [{ id: "spawn1" }],
    });
  });

  it("marks a thread without a workstream as deliberately unassigned", async () => {
    const { w } = await setup({});
    await w.harness.behavior.callRpc("startThread", {
      sectionId: null,
      execution,
    });
    expect(w.spawned[0]).toMatchObject({
      sectionId: null,
      pluginMetadata: { unassignedByRouter: true, filedBy: "user" },
    });
  });

  it("refuses a workstream that no longer exists", async () => {
    const { w } = await setup({});
    await expect(
      w.harness.behavior.callRpc("startThread", {
        sectionId: "sec_gone",
        execution,
      }),
    ).rejects.toThrow(/no longer exists/);
    expect(w.spawned).toHaveLength(0);
  });
});

describe("sendToThread", () => {
  it("queues the composer's input in the thread and journals it", async () => {
    const { w } = await setup({});
    const input = [{ type: "text", text: "Also handle CRLF", mentions: [] }];
    expect(
      await w.harness.behavior.callRpc("sendToThread", {
        threadId: "a1",
        input,
      }),
    ).toEqual({ threadId: "a1" });
    expect(w.sent).toEqual([
      { threadId: "a1", input, mode: "queue-if-active" },
    ]);
    const [entry] = await journal(w);
    expect(entry).toMatchObject({
      action: "route",
      source: "user",
      rationale: "Sent to Alpha task from New work",
    });
  });

  it("refuses an archived thread", async () => {
    const { w } = await setup({});
    w.addThread("old", { archivedAt: Date.now(), title: "Old" });
    await expect(
      w.harness.behavior.callRpc("sendToThread", {
        threadId: "old",
        input: [{ type: "text", text: "Hi", mentions: [] }],
      }),
    ).rejects.toThrow(/archived/);
    expect(w.sent).toHaveLength(0);
  });
});

it("createWorkstream records the proposed scope", async () => {
  const { w } = await setup({});
  const { sectionId } = (await w.harness.behavior.callRpc("createWorkstream", {
    name: "Billing",
    description: "Invoices and payment flows",
  })) as { sectionId: string };
  const state = (await w.harness.behavior.callRpc("state", null)) as {
    workstreams: Record<string, { name: string; description: string | null }>;
  };
  expect(state.workstreams[sectionId]).toMatchObject({
    name: "Billing",
    description: "Invoices and payment flows",
  });
});
