import { afterEach, describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fakeWorld } from "./fake-bb.ts";
import { WORKER_THREAD_MARKER } from "../../src/domain/worker.ts";
import { RECAP_INSTRUCTIONS } from "../../src/domain/recap.ts";
import { QUESTION_INSTRUCTIONS } from "../../src/server/questions/tool-definition.ts";

/**
 * bb's cap on each instruction contribution, in characters: it cuts longer
 * `configure` and `contributeInstructions` output at this length, and
 * rejects a tool whose registered instructions are longer
 * (apps/server/src/services/threads/thread-runtime-config.ts and
 * packages/plugin-sdk/src/internal/host-policy.ts in bb).
 */
const BB_INSTRUCTIONS_MAX_CHARS = 4096;

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
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
  /** Everything the session's agent reads: tool instructions, then `configure`'s. */
  const delivered = (resolved: Awaited<ReturnType<typeof resolve>>) =>
    [...resolved.tools.map((tool) => tool.instructions), resolved.instructions]
      .filter((text): text is string => text !== null)
      .join("\n\n");

  it("configures tools independently of thread hierarchy and workstream placement", async () => {
    const w = await setup();
    const task = await resolve(w, { id: "task" });
    expect(task.instructions).not.toContain("Alpha");
    expect(task.instructions).not.toContain("task thread");
    expect(task.instructions).not.toContain("bb workstreams handoff");
    expect(task.instructions).not.toContain("wf task new");
    expect(task.tools.map((tool) => tool.name)).toEqual([
      "WorkstreamsRecap",
      "AskUserQuestion",
    ]);
    expect(delivered(task)).toContain("End every turn with WorkstreamsRecap");
    const kid = await resolve(w, { id: "kid", parentThreadId: "task" });
    expect(delivered(kid)).toEqual(delivered(task));
    expect(kid.tools.map((tool) => tool.name)).toEqual(
      task.tools.map((tool) => tool.name),
    );
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
    expect(delivered(normal)).toContain("End every turn with WorkstreamsRecap");
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
    expect(delivered(side)).not.toContain("WorkstreamsRecap");
    expect(side.tools.map((tool) => tool.name)).toEqual(["AskUserQuestion"]);
    // A thread with no role yet still ends its turns with a recap.
    const unknown = await resolve(w, { id: "hidden-helper" });
    expect(delivered(unknown)).not.toContain("workstream");
    expect(delivered(unknown)).toContain("WorkstreamsRecap");
    expect(delivered(unknown)).toContain(
      "Include one to three relevant next actions whenever the user can take or request one",
    );
  });

  it("configures unseen threads independently of role metadata freshness", async () => {
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
    expect(fresh.instructions).not.toContain("Alpha");
    expect(delivered(fresh)).toContain("End every turn with WorkstreamsRecap");
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
    expect(delivered(copy)).toEqual(delivered(fresh));
    expect(copy.tools.map((tool) => tool.name)).toEqual(
      fresh.tools.map((tool) => tool.name),
    );
  });

  it.each([
    ["a task thread", {}],
    ["a provider with its own question tool", { nativeQuestions: true }],
    ["a side chat", { sideChat: true }],
  ] as const)(
    "keeps each instruction contribution within bb's limit for %s",
    async (_, options: { nativeQuestions?: boolean; sideChat?: boolean }) => {
      const w = await setup();
      const { agentConfigurationProvider, instructionProvider, agentTools } =
        w.harness.inspection.registrations;
      // The plugin's own output, before bb would cut anything.
      const configured = agentConfigurationProvider!(
        makePluginAgentConfigurationContext({
          thread: { id: "task", parentThreadId: null },
          ...(options.sideChat
            ? { origin: { kind: "fork", pluginId: "side-chat" } }
            : {}),
          ...(options.nativeQuestions
            ? {
                provider: {
                  capabilities: { supportsNativeUserQuestion: true },
                },
              }
            : {}),
        }),
      );
      const selected = configured.tools.map((tool) =>
        typeof tool === "string" ? tool : tool.name,
      );
      const contributions = [
        configured.instructions ?? null,
        instructionProvider?.({ threadId: "task", projectId: "p" }) ?? null,
        ...agentTools
          .filter((tool) => selected.includes(tool.name))
          .map((tool) => tool.instructions),
      ].filter((text): text is string => text !== null);
      for (const text of contributions)
        expect(text.length).toBeLessThanOrEqual(BB_INSTRUCTIONS_MAX_CHARS);
      // Each requirement reaches the agent whole.
      const text = contributions.join("\n\n");
      expect(text).toContain(QUESTION_INSTRUCTIONS);
      if (options.sideChat) expect(text).not.toContain(RECAP_INSTRUCTIONS);
      else expect(text).toContain(RECAP_INSTRUCTIONS);
    },
  );
});
