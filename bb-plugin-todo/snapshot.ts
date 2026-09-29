import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { emptyState, replayCall, type Call, type State } from "./model.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 80;
export type Event = { seq: number; type: string; data: unknown };
export type TodoSnapshot = State & { pendingClear: string | null; completedClear: string | null };
const record = (value: unknown): value is Call => !!value && typeof value === "object" && !Array.isArray(value);
export const validRequestId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** A pending event masks old work until the matching durable completion arrives. */
export function resetFromEvent(event: Event): { status: "pending"; requestId: string } | { status: "completed"; requestId: string; nextId: number } | null {
  if (event.type !== "system/plugin-todo-reset" || !record(event.data)) return null;
  const { pluginId, requestId, status, nextId } = event.data;
  if (pluginId !== "pi-todo" || !validRequestId(requestId)) return null;
  const keys = Object.keys(event.data);
  if (status === "pending" && keys.length === 3 && nextId === undefined) return { status, requestId };
  if (status === "completed" && keys.length === 4 && typeof nextId === "number" && Number.isSafeInteger(nextId) && nextId > 0) return { status, requestId, nextId };
  return null;
}

export function callFromEvent(event: Event): Call | null {
  if (event.type !== "item/completed" || !record(event.data) || !record(event.data.item)) return null;
  const tool = event.data.item;
  if (tool.type !== "toolCall" || tool.tool !== "todo" || tool.status !== "completed") return null;
  if (typeof tool.error === "string" && tool.error.length > 0) return null;
  if (typeof tool.result === "string" && /^Error:/i.test(tool.result.trimStart())) return null;
  if (record(tool.result) && (tool.result.isError === true || tool.result.error === true)) return null;
  return record(tool.arguments) ? tool.arguments : null;
}

export async function snapshotForThread(bb: BbPluginApi, threadId: string): Promise<TodoSnapshot> {
  let state = emptyState();
  let pendingClear: string | null = null;
  let completedClear: string | null = null;
  let afterSeq: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const page = await bb.sdk.threads.events.list({ threadId, limit: String(PAGE_SIZE), order: "asc", ...(afterSeq ? { afterSeq } : {}) });
    if (!page.length) return { ...state, tasks: pendingClear ? [] : state.tasks, pendingClear, completedClear };
    for (const event of page) {
      const reset = resetFromEvent(event);
      if (reset?.status === "pending") { pendingClear = reset.requestId; continue; }
      if (reset?.status === "completed") {
        if (pendingClear === reset.requestId) {
          state = { tasks: [], nextId: reset.nextId };
          pendingClear = null;
          completedClear = reset.requestId;
        }
        continue;
      }
      const call = callFromEvent(event);
      if (call && !pendingClear) state = replayCall(state, call);
    }
    const last = page.at(-1)!;
    if (afterSeq !== undefined && last.seq <= Number(afterSeq)) throw new Error("Todo timeline pagination did not advance");
    afterSeq = String(last.seq);
    if (page.length < PAGE_SIZE) return { ...state, tasks: pendingClear ? [] : state.tasks, pendingClear, completedClear };
  }
  throw new Error(`Todo timeline exceeds ${PAGE_SIZE * MAX_PAGES} completed events; refusing a partial snapshot`);
}
