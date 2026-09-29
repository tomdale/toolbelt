/**
 * An in-memory BB world behind the SDK harness: threads and sections that the
 * plugin reads and mutates, plus helpers for tests to change them "elsewhere".
 */
import {
  createFakePluginHost,
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

export async function fakeWorld() {
  const threads = new Map<string, Thread>();
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

  const host = createFakePluginHost({
    pluginId: "workstreams",
    sdk: {
      threads: {
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
  // Let the initial (seeding) reconcile run before tests act.
  await host.harness.behavior.callRpc("refresh", null);
  return { ...host, threads, sections, addThread, addSection };
}
