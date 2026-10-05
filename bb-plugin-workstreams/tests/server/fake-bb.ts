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
import { migrateLegacyPrefs, savePrefs } from "../../src/server/prefs.ts";

type Thread = ReturnType<typeof makeThreadResponse>;
type Section = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

/** The model's answer: its text, or its text with a reasoning summary. */
type FakeAnswer = string | { text: string; reasoning: string };
export type FakeCompletion = (call: {
  prompt: string;
  model: string;
  /** The host call's abort signal. */
  signal?: AbortSignal;
}) => FakeAnswer | Promise<FakeAnswer>;

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
    settings?: Record<string, string | boolean>;
    send?: (args: Record<string, unknown>) => Promise<void>;
    spawn?: (args: Record<string, unknown>) => Promise<Thread>;
  } = {},
) {
  const threads = new Map<string, Thread>();
  /** Per-thread conversation served by promptHistory/events/output. */
  const conversations = new Map<
    string,
    { requests: string[]; output: string | null }
  >();
  const completions: { prompt: string; model: string }[] = [];
  const spawned: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  const projects = ["proj_1", "proj_home", "proj_other", "proj_personal"].map(
    (id) => ({ id, name: "Zebracorn", sources: [] }),
  );
  const workerCalls: Record<string, unknown>[] = [];
  const markedUnread: string[] = [];
  /** Each thread's latest agent turn: its number and how it ended. */
  const turns = new Map<string, { n: number; status: string }>();
  const sections: Section[] = [];
  let nextSection = 1;
  const addThread = (id: string, overrides: Partial<Thread> = {}) => {
    const thread = makeThreadResponse({
      id,
      title: `Thread ${id}`,
      projectId: "proj_1",
      environmentId: "env_1",
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
    settings: { understandingAutomatic: false, ...options.settings },
    experimental_callHostRpc: async (call) => {
      const input = call.input as { prompt: string; model: string };
      completions.push(input);
      const answer = await (options.complete?.({
        ...input,
        signal: call.signal,
      }) ?? DEFAULT_ANSWER);
      const usage = { input: 100, output: 20, cost: 0.0001 };
      return typeof answer === "string"
        ? { text: answer, usage }
        : { ...answer, usage, stopReason: "stop" };
    },
    sdk: {
      plugins: {
        getSettings: async ({ pluginId }: { pluginId: string }) => {
          if (pluginId !== "workstreams") throw new Error("Unknown plugin");
          const values = Object.fromEntries(
            Object.entries(options.settings ?? {}).map(([key, value]) => [
              (
                {
                  showParentThreadLink: "showParentThreadLink",
                  showForYou: "showForYou",
                  showRecent: "showRecent",
                  model: "model",
                  autoTitle: "autoTitle",
                  hostId: "hostId",
                  organizeModel: "organizeModel",
                  homeProjectId: "homeProjectId",
                  debug: "debug",
                } as Record<string, string>
              )[key] ?? key,
              value,
            ]),
          );
          return { ok: true, schema: {}, values };
        },
      },
      projects: {
        // A distinctive name that must never reach a model prompt.
        list: async () => [...projects],
        get: async () => ({ id: "proj_1", name: "Zebracorn" }),
        sidebarBootstrap: async () => ({
          personalProject: { id: "proj_personal", name: "Personal" },
        }),
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({
          id: environmentId,
          hostId: "host_1",
          projectId: "proj_1",
          status: "ready",
          hostLifecycle: "active",
          lifecycle: { phase: "active" },
        }),
      },
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host_1", status: "connected" } as never),
        ],
      },
      providers: {
        models: async () => ({
          models: [
            {
              id: "model-1",
              model: "gpt-5.5",
              isDefault: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
            },
          ],
          providers: [{ id: "openai", serviceTiers: [{ id: "fast" }] }],
          modelLoadError: null,
          permissionCeiling: "accept-edits",
          selectedOnlyModels: [],
        }),
      },
      threads: {
        getPluginMetadata: async () => ({}),
        promptHistory: async ({ threadId }: { threadId: string }) =>
          [...(conversations.get(threadId)?.requests ?? [])]
            .reverse()
            .map((value, i) => ({
              id: `p${i}`,
              createdAt: i,
              input: text(value),
            })),
        spawn: async (args: Record<string, unknown>) => {
          if (options.spawn) return options.spawn(args);
          if (args.title === "Workstreams worker") {
            workerCalls.push(args);
            const answer = await (options.complete?.({
              prompt: String(args.prompt),
              model: String(args.model),
            }) ?? DEFAULT_ANSWER);
            conversations.set(`worker${workerCalls.length}`, {
              requests: [],
              output: typeof answer === "string" ? answer : answer.text,
            });
            return addThread(`worker${workerCalls.length}`, {
              title: "Workstreams worker",
              visibility: "hidden",
              projectId: args.projectId as string,
            });
          }
          spawned.push(args);
          const thread = addThread(`spawn${spawned.length}`, {
            sectionId: (args.sectionId as string | null) ?? null,
            projectId: args.projectId as string,
            parentThreadId: (args.parentThreadId as string | null) ?? null,
          });
          return thread;
        },
        send: async (args: Record<string, unknown>) => {
          await options.send?.(args);
          sent.push(args);
          return { status: "sent" };
        },
        timeline: async () => ({ goal: null, pendingTodos: null }),
        markUnread: async ({ threadId }: { threadId: string }) => {
          markedUnread.push(threadId);
          return { id: threadId };
        },
        stop: async () => ({ ok: true }),
        wait: async ({ threadId }: { threadId: string }) => ({
          matched: true,
          target: { kind: "status", status: "idle" },
          threadId,
        }),
        archive: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (!thread) throw missing(threadId);
          threads.set(threadId, { ...thread, archivedAt: Date.now() });
          return { id: threadId };
        },
        unpin: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (!thread) throw missing(threadId);
          threads.set(threadId, { ...thread, pinnedAt: null });
          return { id: threadId };
        },
        output: async ({ threadId }: { threadId: string }) => ({
          output: conversations.get(threadId)?.output ?? null,
        }),
        events: {
          list: async ({
            threadId,
            types,
          }: {
            threadId: string;
            types?: string[];
          }) => {
            const type = types?.[0];
            if (type === "turn/started" || type === "turn/completed") {
              const turn = turns.get(threadId);
              if (!turn) return [];
              const started = type === "turn/started";
              return [
                {
                  id: `e${turn.n}`,
                  threadId,
                  seq: turn.n * 10 + (started ? 1 : 2),
                  scope: { kind: "turn", turnId: `${threadId}-t${turn.n}` },
                  type,
                  data: started ? {} : { status: turn.status },
                  createdAt: 0,
                },
              ];
            }
            return (conversations.get(threadId)?.requests ?? []).map(
              (value, i) => ({
                seq: i + 1,
                type: "client/turn/requested",
                data: { input: text(value) },
              }),
            );
          },
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
          return all
            .slice(offset, offset + (args.limit ?? 100))
            .map((thread) => ({
              queuedWork: "none",
              hasPendingInteraction: false,
              activity: {
                activeBackgroundAgentCount: 0,
                activeBackgroundCommandCount: 0,
                activeGoalCount: 0,
                activePlanModeCount: 0,
                activeWorkflowCount: 0,
              },
              ...thread,
            }));
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
  if (options.settings) {
    const db = host.bb.storage.database();
    savePrefs(db, migrateLegacyPrefs(options.settings));
    if (typeof options.settings.suggestions === "boolean")
      savePrefs(db, { newWork: { suggestions: options.settings.suggestions } });
  }
  // Let the load-time reconcile and analysis catch-up run on the empty world
  // before tests act, then seed explicitly.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await host.harness.behavior.callRpc("refresh", null);
  const converse = (
    id: string,
    requests: string[],
    output: string | null = "Done.",
  ) => conversations.set(id, { requests, output });
  /** Starts the thread's next agent turn, ending it with `status`. */
  const turn = (id: string, status = "completed") => {
    const n = (turns.get(id)?.n ?? 0) + 1;
    turns.set(id, { n, status });
    return `${id}-t${n}`;
  };
  return {
    ...host,
    turn,
    threads,
    sections,
    addThread,
    addSection,
    converse,
    completions,
    spawned,
    workerCalls,
    sent,
    markedUnread,
  };
}
