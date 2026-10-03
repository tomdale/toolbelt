/**
 * New work's server side: a suggestion names one likely home (possibly a new
 * workstream) and keeps nothing to execute; accepting or ignoring it goes
 * through `startThread`, `sendToThread` and `createWorkstream`.
 */
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

async function setup(
  answer: Record<string, unknown>,
  settings: Record<string, string | boolean> = {},
) {
  let alphaEntityId = "";
  world = await fakeWorld({
    settings,
    complete: ({ prompt }) => {
      if (prompt.includes("Classify the most specific")) {
        if (answer.outcome === "new-workstream" || answer.name === "Billing") {
          return JSON.stringify({
            subjectId: null,
            proposed: {
              name: String(answer.name ?? "Billing"),
              description: String(answer.description ?? "Invoices and payment flows"),
              parentId: null,
            },
          });
        }
        if (answer.outcome === "unsure") {
          return JSON.stringify({ subjectId: null, proposed: null });
        }
        return JSON.stringify({
          subjectId: alphaEntityId,
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
      description: "Alpha product",
      aliases: [],
    },
  ]);
  alphaEntityId = corpus.list().find((e) => e.name === "Alpha")!.id;
  w.addThread("a1", {
    sectionId: alpha.id,
    projectId: "proj_1",
    title: "Alpha task",
  });
  await w.harness.behavior.callRpc("refresh", null);
  return { w, alpha, corpus, alphaEntityId };
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
  it("classifies draft and suggests an existing active workstream home", async () => {
    const { w, alpha, alphaEntityId } = await setup({
      outcome: "new-thread",
      workstream: "Alpha",
    });
    const decision = await suggest(w, "Fix the parser in Alpha");
    expect(decision).toMatchObject({
      outcome: "new-thread",
      sectionId: alpha.id,
      workstream: "Alpha",
      subject: "Alpha",
      subjectId: alphaEntityId,
    });
  });

  it("proposes a new workstream when feature has no active home", async () => {
    const { w } = await setup({
      outcome: "new-workstream",
      name: "Billing",
      description: "Invoices and payment flows",
    });
    const decision = await suggest(w, "Add CSV export for invoices");
    expect(decision).toMatchObject({
      outcome: "new-workstream",
      name: "Billing",
      description: "Invoices and payment flows",
    });
  });

  it("turns an unclassifiable request into unsure without side effects", async () => {
    const { w } = await setup({ outcome: "unsure" });
    const decision = await suggest(w, "Something vague and random");
    expect(decision).toMatchObject({
      outcome: "unsure",
      reason: "The subject is not clear enough to classify.",
    });
  });

  it("short-circuits on a thread mention without calling the classifier", async () => {
    const { w } = await setup({});
    const decision = await suggest(w, "Follow up in @thread:a1");
    expect(decision).toMatchObject({
      outcome: "continue",
      threadId: "a1",
      workstream: "Alpha",
    });
  });

  it("short-circuits on a workstream mention without calling the classifier", async () => {
    const { w, alpha } = await setup({});
    const decision = await suggest(w, "New task in @section:sec_1");
    expect(decision).toMatchObject({
      outcome: "new-thread",
      sectionId: alpha.id,
      workstream: "Alpha",
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

describe("Suggestions preference", () => {
  it("returns an empty no-suggestion decision without a model call", async () => {
    const { w } = await setup(
      {
        outcome: "new-thread",
        workstream: "Alpha",
        title: "Parser fix",
        code: true,
        confidence: "high",
        reason: "Fits",
      },
      { suggestions: false },
    );
    const routeCalls = () =>
      w.completions.filter((call) =>
        call.prompt.includes("Someone is starting new work"),
      ).length;
    const before = routeCalls();
    const decision = await suggest(w, "Fix the parser");
    expect(decision).toMatchObject({ outcome: "new-thread", traceId: null });
    expect(decision.title).toBe("");
    expect(routeCalls()).toBe(before);
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
    const { durationMs } = decision.explanation as {
      notes: string[];
      durationMs: number;
    };
    expect(durationMs).toBeGreaterThanOrEqual(0);
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
