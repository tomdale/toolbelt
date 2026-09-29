/**
 * An in-memory BB world behind the SDK harness: threads and sections that the
 * plugin reads and mutates, plus helpers for tests to change them "elsewhere".
 */
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../../src/server/index.ts";

type Thread = ReturnType<typeof makeThreadResponse>;
type Section = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type FakeCompletion = (call: {
  prompt: string;
  model: string;
}) => string | Promise<string>;

const DEFAULT_ANSWER = JSON.stringify({
  recap: "Fixed the bug; tests pass.",
  state: "review",
  needsYou: null,
  subject: "Alpha",
  drift: null,
});

export async function fakeWorld(
  options: {
    complete?: FakeCompletion;
    settings?: Record<string, string>;
  } = {},
) {
  const threads = new Map<string, Thread>();
  /** Per-thread conversation served by promptHistory/events/output. */
  const conversations = new Map<
    string,
    { requests: string[]; output: string | null }
  >();
  const completions: { prompt: string; model: string }[] = [];
  const sections: Section[] = [];
  let nextSection = 1;
  const addThread = (id: string, overrides: Partial<Thread> = {}) => {
    const thread = makeThreadResponse({
      id,
      title: `Thread ${id}`,
      sectionId: null,
      parentThreadId: null,
      archivedAt: null,
      visibility: "visible",
      latestAttentionAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    });
    threads.set(id, thread);
    return thread;
  };
  const addSection = (name: string, id = `sec_${nextSection++}`) => {
    const section = { id, name, createdAt: 1, updatedAt: 1 };
    sections.push(section);
    return section;
  };
  const missing = (id: string) =>
    Object.assign(new Error(`Thread ${id} not found`), { status: 404 });

  const text = (value: string) => [{ type: "text", text: value }];
  const host = createFakePluginHost({
    pluginId: "workstreams",
    settings: options.settings,
    experimental_callHostRpc: async (call) => {
      const input = call.input as { prompt: string; model: string };
      completions.push(input);
      const answer = await (options.complete?.(input) ?? DEFAULT_ANSWER);
      return { text: answer, usage: { input: 100, output: 20, cost: 0.0001 } };
    },
    sdk: {
      projects: {
        // A distinctive name that must never reach an analysis prompt.
        list: async () => [{ id: "proj_1", name: "Zebracorn" }],
        get: async () => ({ id: "proj_1", name: "Zebracorn" }),
      },
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host_1", status: "connected" } as never),
        ],
      },
      threads: {
        promptHistory: async ({ threadId }: { threadId: string }) =>
          [...(conversations.get(threadId)?.requests ?? [])]
            .reverse()
            .map((value, i) => ({
              id: `p${i}`,
              createdAt: i,
              input: text(value),
            })),
        output: async ({ threadId }: { threadId: string }) => ({
          output: conversations.get(threadId)?.output ?? null,
        }),
        events: {
          list: async ({ threadId }: { threadId: string }) =>
            (conversations.get(threadId)?.requests ?? []).map((value, i) => ({
              seq: i + 1,
              type: "client/turn/requested",
              data: { input: text(value) },
            })),
        },
        list: async (args: {
          archived?: boolean;
          includeHidden?: boolean;
          sectionId?: string;
          limit?: number;
          offset?: number;
        }) => {
          const all = [...threads.values()].filter(
            (t) =>
              (args.archived ? t.archivedAt !== null : t.archivedAt === null) &&
              (args.includeHidden || t.visibility !== "hidden") &&
              (!args.sectionId || t.sectionId === args.sectionId),
          );
          const offset = args.offset ?? 0;
          return all.slice(offset, offset + (args.limit ?? 100));
        },
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (!thread) throw missing(threadId);
          return thread;
        },
        update: async ({
          threadId,
          ...patch
        }: {
          threadId: string;
          sectionId?: string | null;
          title?: string | null;
        }) => {
          const thread = threads.get(threadId);
          if (!thread) throw missing(threadId);
          const next = { ...thread, ...patch } as Thread;
          threads.set(threadId, next);
          return next;
        },
      },
      threadSections: {
        list: async () => [...sections],
        create: async ({ name }: { name: string }) => addSection(name),
        update: async ({ id, name }: { id: string; name: string }) => {
          const section = sections.find((s) => s.id === id);
          if (!section) throw new Error("no section");
          section.name = name;
          return section;
        },
        delete: async ({ id }: { id: string }) => {
          const index = sections.findIndex((s) => s.id === id);
          if (index >= 0) sections.splice(index, 1);
          for (const [tid, t] of threads)
            if (t.sectionId === id) threads.set(tid, { ...t, sectionId: null });
          return { id, name: "" };
        },
      },
    } as never,
  });
  await plugin(host.bb);
  // Let the load-time reconcile and analysis catch-up run on the empty world
  // before tests act, then seed explicitly.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await host.harness.behavior.callRpc("refresh", null);
  const converse = (
    id: string,
    requests: string[],
    output: string | null = "Done.",
  ) => conversations.set(id, { requests, output });
  return {
    ...host,
    threads,
    sections,
    addThread,
    addSection,
    converse,
    completions,
  };
}
