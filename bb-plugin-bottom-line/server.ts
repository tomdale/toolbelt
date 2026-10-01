import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { answersSchema, cardSchema, deliverSchema, finishSchema, INSTRUCTIONS, QUESTIONS_RENDERER, questionsSchema, TOOLS, type Card } from "./contracts";
import { createStore } from "./store";

const target = z.object({ threadId: z.string().min(1).max(256), cardId: z.string().uuid() }).strict();
export const rpcContract = defineRpcContract({
  current: {
    input: z.object({ threadId: z.string().min(1).max(256) }).strict(),
    output: z.object({ card: cardSchema.nullable(), capped: z.boolean(), intercepts: z.number(), environmentId: z.string().nullable() }).strict(),
  },
  dismiss: { input: target, output: z.object({ ok: z.literal(true) }) },
  archive: { input: target, output: z.object({ ok: z.literal(true) }) },
});

export default async function plugin(bb: BbPluginApi) {
  const store = createStore(bb);
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Require a Bottom Line", default: true },
    maxIntercepts: {
      type: "number", label: "Maximum corrections per handoff", default: 3,
      description: "Automatic continuations after a turn misses its handoff. A fresh message resets the budget. Zero disables corrections.",
      experimental_schema: z.number().int().min(0).max(10),
    },
  });
  let config = await settings.get();
  settings.onChange((next) => { config = next; });
  const controller = new AbortController();
  const pending = new Map<string, Promise<void>>();
  const repeat = new Set<string>();
  const changed = (threadId: string) => bb.realtime.publish("changed", { threadId });
  const error = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
  const latestStart = async (threadId: string, signal = controller.signal) => {
    const [start] = await bb.sdk.threads.events.list({ threadId, types: ["turn/started"], order: "desc", limit: "1", signal });
    if (!start || start.scope.kind !== "turn") throw new Error("No current agent turn.");
    return start;
  };
  const accept = async (threadId: string, signal: AbortSignal, build: (turnId: string) => Card | null) => {
    const epoch = store.get(threadId).epoch;
    const start = await latestStart(threadId, signal);
    signal.throwIfAborted();
    if (start.scope.kind !== "turn") throw new Error("No current agent turn.");
    const card = build(start.scope.turnId);
    if (!store.accept(threadId, epoch, start.scope.turnId, card)) throw new Error("The conversation changed; repeat the handoff for the current turn.");
    changed(threadId);
  };

  bb.agents.registerTool({
    name: TOOLS[0], description: "Ask concrete questions or propose next steps for the user to choose, then await their answers. Each question offers suggestions and freeform input.",
    presentation: { label: { pending: "Asking questions", completed: "Received answers" }, suppress: true },
    parameters: questionsSchema,
    async execute(input, ctx) {
      try {
        // The pending interaction is the handoff even while the detached call awaits an answer.
        const response = await bb.ui.requestInput({
          threadId: ctx.threadId, rendererId: QUESTIONS_RENDERER, title: "Questions and next steps",
          payload: input, timeoutMs: 60 * 60 * 1000,
        }, { signal: ctx.signal });
        if (response.outcome === "cancelled") return error("Questions dismissed or expired. No answer or approval was supplied; continue only work independent of the missing input.");
        const parsed = answersSchema.safeParse(response.value);
        if (!parsed.success || parsed.data.answers.length !== input.questions.length) return error("The answers could not be read. Required input remains unresolved.");
        return JSON.stringify({ questions: input.questions.map((q) => q.question), answers: parsed.data.answers });
      } catch (e) { return error(e instanceof Error ? e.message : String(e)); }
    },
  });
  for (const kind of ["deliverables", "finished"] as const) {
    bb.agents.registerTool({
      name: kind === "finished" ? TOOLS[2] : TOOLS[1],
      description: kind === "finished"
        ? "Indicate the overall task is finished. Show a concise completion summary and any requested artifacts, with an Archive button the user can dismiss."
        : "Hand the user one or more existing deliverables they requested, such as a report, code change, or generated file. Supply a summary and clickable absolute paths or HTTPS URLs.",
      presentation: { label: { pending: "Preparing handoff", completed: kind === "finished" ? "Task finished" : "Delivered requested artifacts" }, suppress: true },
      parameters: kind === "finished" ? finishSchema : deliverSchema,
      async execute(input, ctx) {
        await accept(ctx.threadId, ctx.signal, (turnId) => ({ id: randomUUID(), turnId, kind, summary: input.summary, deliverables: input.deliverables }));
        return "Your handoff is shown to the user. End the turn with a concise final response.";
      },
    });
  }
  bb.agents.configure((context) => {
    const enabled = config.enabled && context.origin.pluginId !== "side-chat";
    store.enroll(context.thread.id, enabled);
    return { tools: enabled ? [...TOOLS] : [], skills: enabled ? ["bottom-line"] : [], instructions: enabled ? INSTRUCTIONS : "" };
  });

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const submission = ctx.experimental_submission;
    // Submission metadata is transient; queued re-attempts retain the opaque marker in their input.
    const queuedMarker = ctx.queuedMessages.length > 0 ? /^\[Bottom Line correction ([a-f0-9-]+) (\d+) (\d+)\]/.exec(ctx.input.text) : null;
    if (submission?.pluginId === bb.pluginId || queuedMarker) {
      const marker = z.object({ epoch: z.number().int(), completedSeq: z.number().int(), token: z.string().uuid() }).safeParse(queuedMarker ? { token: queuedMarker[1], epoch: Number(queuedMarker[2]), completedSeq: Number(queuedMarker[3]) } : submission?.data);
      const state = store.get(ctx.thread.id);
      if (!marker.success || !config.enabled || !state.enrolled || ctx.thread.status !== "idle" || ctx.thread.archivedAt !== null || ctx.thread.visibility !== "visible" || ctx.thread.queuedMessageCount > ctx.queuedMessages.length || state.correction_token !== marker.data.token || state.epoch !== marker.data.epoch || state.checked_seq !== marker.data.completedSeq) {
        return { action: "reject", message: "Bottom Line correction cancelled because the conversation changed." };
      }
      return { action: "proceed" };
    }
    store.reset(ctx.thread.id, ctx.queuedMessages.length ? ctx.queuedMessages.map((row) => row.id).join(",") : null);
    changed(ctx.thread.id);
    return { action: "proceed" };
  });

  bb.events.on("interaction.pending", async ({ thread, interaction }) => {
    if (!config.enabled || !store.get(thread.id).enrolled) return;
    if (interaction.payload.kind === "user_question" || (interaction.origin?.kind === "plugin" && ((interaction.origin.pluginId === bb.pluginId && interaction.origin.rendererId === QUESTIONS_RENDERER) || (interaction.origin.pluginId === "toolbelt-ask-user-question" && interaction.origin.rendererId === "ask-user-question")))) {
      if (interaction.turnId) store.accept(thread.id, store.get(thread.id).epoch, interaction.turnId, null);
      changed(thread.id);
    }
  });

  async function enforce(threadId: string) {
    if (!config.enabled || config.maxIntercepts === 0 || !store.get(threadId).enrolled) return;
    const state = store.get(threadId);
    const [completed] = await bb.sdk.threads.events.list({ threadId, types: ["turn/completed"], order: "desc", limit: "1", signal: controller.signal });
    if (!completed || completed.type !== "turn/completed" || completed.data.status !== "completed" || completed.scope.kind !== "turn" || completed.seq <= state.checked_seq) return;
    const start = await latestStart(threadId);
    if (start.scope.kind !== "turn" || start.scope.turnId !== completed.scope.turnId) return;
    if (state.accepted_turn === completed.scope.turnId) { store.check(threadId, completed.seq); return; }
    const thread = await bb.sdk.threads.get({ threadId, signal: controller.signal });
    if (thread.status !== "idle" || thread.archivedAt !== null || thread.visibility !== "visible" || thread.queuedMessageCount > 0 || controller.signal.aborted) return;
    const token = randomUUID();
    if (!store.reserve(threadId, state.epoch, completed.seq, config.maxIntercepts, token)) {
      store.cap(threadId, state.epoch, completed.seq, config.maxIntercepts);
      changed(threadId); return;
    }
    changed(threadId);
    await bb.sdk.threads.send({
      threadId, mode: "start",
      pluginSubmission: { pluginId: bb.pluginId, data: { epoch: state.epoch, completedSeq: completed.seq, token } },
      input: [{ type: "text", visibility: "agent-only", text: `[Bottom Line correction ${token} ${state.epoch} ${completed.seq}]\nBottom Line: your turn ended without a concrete handoff. Call BottomLineAskQuestions for concrete questions or next steps, BottomLineDeliver for requested artifacts, or BottomLineFinish if the overall task is finished. Complete any remaining authorized work first. Correction ${state.intercepts + 1} of ${config.maxIntercepts}.`, mentions: [] }],
    });
  }
  bb.events.on("thread.idle", ({ thread }) => {
    if (pending.has(thread.id)) { repeat.add(thread.id); return pending.get(thread.id); }
    const work = (async () => {
      do {
        repeat.delete(thread.id);
        await enforce(thread.id);
      } while (repeat.has(thread.id) && !controller.signal.aborted);
    })().catch((e) => {
      if (!controller.signal.aborted) bb.log.warn(`Handoff correction failed: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => { pending.delete(thread.id); repeat.delete(thread.id); });
    pending.set(thread.id, work);
    return work;
  });
  bb.events.on("thread.deleted", ({ thread }) => store.remove(thread.id));
  bb.events.on("thread.archived", ({ thread }) => { store.enroll(thread.id, false); changed(thread.id); });

  bb.rpc.register(rpcContract, {
    current: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const state = store.get(threadId);
      return { card: store.card(threadId), environmentId: thread.environmentId, capped: config.enabled && config.maxIntercepts > 0 && Boolean(state.capped) && thread.status === "idle", intercepts: state.intercepts };
    },
    dismiss: ({ threadId, cardId }) => { store.dismiss(threadId, cardId); changed(threadId); return { ok: true as const }; },
    archive: async ({ threadId, cardId }) => {
      const card = store.card(threadId);
      if (!card || card.id !== cardId || card.kind !== "finished") throw new Error("This completion card is no longer current.");
      const thread = await bb.sdk.threads.get({ threadId });
      if (store.card(threadId)?.id !== cardId) throw new Error("This completion card is no longer current.");
      if (thread.status !== "idle" || thread.queuedMessageCount > 0) throw new Error("Wait for the thread to finish before archiving.");
      await bb.sdk.threads.archive({ threadId });
      return { ok: true as const };
    },
  });
  bb.onDispose(async () => { controller.abort(); await Promise.allSettled(pending.values()); });
}
