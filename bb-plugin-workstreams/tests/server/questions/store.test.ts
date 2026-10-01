import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../../src/server/db.ts";
import { QuestionStore } from "../../../src/server/questions/store.ts";
import { registerQuestionTool } from "../../../src/server/questions/tool.ts";

const input = {
  questions: [
    { question: "Ship it?", header: "Ship", options: [], multiSelect: false },
  ],
};

function setup() {
  const send = vi.fn(async () => ({ status: "started" }));
  const host = createFakePluginHost({
    pluginId: "workstreams",
    sdk: { threads: { send, events: { list: async () => [] } } },
  });
  let store: QuestionStore;
  const plugin = (bb: typeof host.bb) => {
    store = new QuestionStore(openDatabase(bb), bb);
    registerQuestionTool(bb, store);
  };
  plugin(host.bb);
  return { host, send, plugin, store: () => store! };
}

describe("durable questions", () => {
  it("recovers old detached answers and avoids duplicating them on repeated history reads", async () => {
    const { host, store } = setup();
    const result = { ...input, answers: { "Ship it?": "Yes, tomorrow" } };
    host.harness.sdk.stub("threads.events.list", async () => [
      {
        id: "event-answer",
        createdAt: 123,
        type: "client/turn/requested",
        data: {
          input: [
            {
              type: "text",
              text: `Your earlier AskUserQuestion tool call has finished. Its result:\n\n${JSON.stringify(result)}`,
            },
          ],
        },
      },
    ]);
    const rows = await store().history("thread");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "answered", result, at: 123 });
    expect(await store().history("thread")).toEqual(rows);
    await host.harness.lifecycle.dispose();
  });
  it("survives plugin reload and delivers the recovered answer as a user message", async () => {
    const { host, send, plugin, store } = setup();
    const call = host.harness.callAgentTool("AskUserQuestion", input);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    const threadId = host.harness.pendingInteractions[0]!.threadId;
    const saved = store().pending(threadId)!;
    await host.harness.lifecycle.reload(plugin);
    await call;
    expect(store().pending(threadId)).toEqual({ ...saved, recoverable: true });
    await store().recover(
      threadId,
      saved.id,
      { answers: { q0: { selected: [], freeText: "Ship tomorrow" } } },
      false,
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]).toEqual([
      expect.objectContaining({
        threadId,
        mode: "auto",
        input: [
          expect.objectContaining({
            text: expect.stringContaining("Ship tomorrow"),
          }),
        ],
      }),
    ]);
    expect(store().pending(threadId)).toBeNull();
    expect((await store().history(threadId))[0]).toMatchObject({
      status: "answered",
      result: { answers: { "Ship it?": "Ship tomorrow" } },
    });
    await expect(
      store().recover(threadId, saved.id, null, true),
    ).rejects.toThrow("no longer pending");
    await host.harness.lifecycle.dispose();
  });

  it("resolves normal answers and explicit dismissal without recovery messages", async () => {
    const { host, send, store } = setup();
    for (const dismiss of [false, true]) {
      const call = host.harness.callAgentTool("AskUserQuestion", input);
      await vi.waitFor(() =>
        expect(host.harness.pendingInteractions).toHaveLength(1),
      );
      const interaction = host.harness.pendingInteractions[0]!;
      if (dismiss) host.harness.cancelInteraction(interaction.id);
      else
        host.harness.submitInteraction(interaction.id, {
          answers: { q0: { selected: [], freeText: "Yes" } },
        });
      await call;
      expect(store().pending(interaction.threadId)).toBeNull();
      expect((await store().history(interaction.threadId))[0]).toMatchObject({
        status: dismiss ? "dismissed" : "answered",
      });
    }
    expect(send).not.toHaveBeenCalled();
    await host.harness.lifecycle.dispose();
  });

  it("retains questions on send failure and rejects empty answers", async () => {
    const { host, send, store } = setup();
    const payload = {
      questions: [
        {
          id: "q0",
          prompt: "Ship it?",
          shortLabel: "Ship",
          options: [],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    };
    const id = store().open("thread", payload);
    store().interrupted(id);
    await expect(
      store().recover("thread", id, { answers: {} }, false),
    ).rejects.toThrow("at least one");
    send.mockRejectedValueOnce(new Error("offline"));
    await expect(store().recover("thread", id, null, true)).rejects.toThrow(
      "offline",
    );
    expect(store().pending("thread")?.id).toBe(id);
    await store().recover("thread", id, null, true);
    expect(send.mock.calls.at(-1)).toEqual([
      expect.objectContaining({
        input: [
          expect.objectContaining({
            text: expect.stringContaining("not an answer or approval"),
          }),
        ],
      }),
    ]);
    await host.harness.lifecycle.dispose();
  });
});
