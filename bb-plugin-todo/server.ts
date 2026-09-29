import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { snapshotForThread, validRequestId } from "./snapshot.ts";

const task = z.object({
  id: z.number().int().positive(), subject: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "deleted"]),
  description: z.string().optional(), activeForm: z.string().optional(),
  parentId: z.number().int().positive().optional(), blockedBy: z.array(z.number().int().positive()).optional(),
  owner: z.string().optional(),
});
export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.object({ threadId: z.string().min(1).max(256) }).strict(),
    output: z.object({ tasks: z.array(task), nextId: z.number().int().positive(), pendingClear: z.string().uuid().nullable(), completedClear: z.string().uuid().nullable() }).strict(),
  },
  clear: {
    input: z.object({ threadId: z.string().min(1).max(256), requestId: z.string().uuid() }).strict(),
    output: z.object({ nextId: z.number().int().positive(), boundarySequence: z.number().int().nonnegative() }).strict(),
  },
});

export default function plugin(bb: BbPluginApi) {
  const inFlight = new Set<string>();
  const key = (threadId: string) => `clear:${threadId}`;
  bb.rpc.register(rpcContract, {
    snapshot: async ({ threadId }) => {
      const state = await snapshotForThread(bb, threadId);
      const stored = await bb.storage.kv.get<string>(key(threadId));
      if (stored && state.completedClear === stored) await bb.storage.kv.delete(key(threadId));
      else if (stored && validRequestId(stored) && !state.pendingClear) return { ...state, tasks: [], pendingClear: stored };
      return state;
    },
    clear: async ({ threadId, requestId }) => {
      if (inFlight.has(threadId)) throw new Error("Pi Todo reset is already in progress for this thread");
      inFlight.add(threadId);
      try {
        const clearKey = key(threadId);
        const state = await snapshotForThread(bb, threadId);
        const stored = await bb.storage.kv.get<string>(clearKey);
        if (stored && !validRequestId(stored)) throw new Error("Stored Pi Todo reset request is invalid");
        if (state.completedClear === requestId) {
          if (stored === requestId) await bb.storage.kv.delete(clearKey);
          throw new Error("Pi Todo has already been cleared; refresh the card");
        }
        if (stored && stored !== requestId || state.pendingClear && state.pendingClear !== requestId) {
          throw new Error("A different Pi Todo reset is pending; retry that request");
        }
        if (!stored) await bb.storage.kv.set(clearKey, requestId);
        const result = await bb.sdk.threads.experimental_providerAction({ threadId, action: "pi-todo.reset", requestId });
        await bb.storage.kv.delete(clearKey);
        bb.realtime.publish("todo-timeline-changed", { threadId });
        return result;
      } finally { inFlight.delete(threadId); }
    },
  });
  for (const event of ["thread.active", "thread.idle"] as const) {
    bb.events.on(event, ({ thread }) => bb.realtime.publish("todo-timeline-changed", { threadId: thread.id }));
  }
}
