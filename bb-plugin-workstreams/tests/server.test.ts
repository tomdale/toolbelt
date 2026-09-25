import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import {
  MODEL,
  classifyBatch,
  normalizeGroups,
  cleanGroupName,
  excerpt,
  mapConcurrent,
  parseClassifications,
  groupThreads,
  type Snapshot,
} from "../model";
import { inferenceArgs } from "../host";

const fixtures: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.harness.lifecycle.dispose();
});
const project = {
  id: "p",
  name: "Personal",
  kind: "personal",
  gitRemoteUrl: null,
};
const thread = (id: string) =>
  makeThreadResponse({
    id,
    projectId: "p",
    title: `Work ${id}`,
    environmentId: null,
    status: "idle",
  });
function setup(count = 17, malformed = false, failTitle?: string) {
  const rows = Array.from({ length: count }, (_, i) => thread(String(i)));
  let running = 0,
    peak = 0;
  const h = createFakePluginHost({
    pluginId: "workstreams",
    sdk: {
      projects: { list: async () => [project] },
      threadSections: {
        list: async () => [],
        create: async ({ name }: { name: string }) => ({
          id: `sec_${name}`,
          name,
        }),
      },
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host", status: "connected" }),
        ],
      },
      threads: {
        events: { list: async () => [] },
        list: async ({
          offset = 0,
          limit = 100,
        }: {
          offset?: number;
          limit?: number;
        } = {}) => rows.slice(offset, offset + limit),
        promptHistory: async () => [],
        output: async () => ({ output: "Working on Vercel Agent for Slack." }),
        get: async ({ threadId }: { threadId: string }) =>
          rows.find((t) => t.id === threadId)!,
        update: async ({ threadId }: { threadId: string }) =>
          rows.find((t) => t.id === threadId)!,
      },
    },
    experimental_callHostRpc: async ({ input }) => {
      running++;
      peak = Math.max(peak, running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (malformed)
          return { text: "not JSON", usage: { input: 1, output: 1, cost: 0 } };
        const prompt = (input as { prompt: string }).prompt;
        const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
        if (prompt.includes("For each workstream"))
          return {
            text: JSON.stringify({
              groups: data.map((g: { name: string }) => ({
                name: g.name,
                about: "About",
                status: "Status",
                motif: "Motif",
              })),
            }),
            usage: { input: 1, output: 1, cost: 0 },
          };
        if (failTitle && data.some((t: any) => t.title === failTitle))
          throw new Error("gateway down");
        return {
          text: JSON.stringify({
            items: data.map((t: any) => ({
              threadId: t.id,
              title: `Feature ${t.id}`,
              group:
                Number(t.title.split(" ").at(-1)) % 2
                  ? "vercel-agent-for-slack"
                  : "Vercel Agent for Slack",
              recap: `Implement feature ${t.id}`,
              state: "done",
            })),
          }),
          usage: { input: 100, output: 10, cost: 0.001 },
        };
      } finally {
        running--;
      }
    },
  });
  fixtures.push(h);
  return { ...h, rows, peak: () => peak };
}
async function snapshot(h: ReturnType<typeof setup>): Promise<Snapshot> {
  return (await h.harness.behavior.callRpc("snapshot", null)) as Snapshot;
}
async function run(h: ReturnType<typeof setup>) {
  await h.harness.behavior.callRpc("analyze", null);
  const service = h.harness.behavior.runService("thread-analysis");
  try {
    await expect
      .poll(async () => (await snapshot(h)).progress, { timeout: 3000 })
      .toBeNull();
  } finally {
    service.controller.abort();
    await service.done;
  }
}

describe("active thread overview", () => {
  it("paginates all active threads without starting analysis", async () => {
    const h = setup(205);
    await plugin(h.bb);
    expect((await snapshot(h)).threads).toHaveLength(205);
    expect(h.harness.inspection.sdk.callsTo("threads.list")).toHaveLength(3);
    expect(h.harness.experimental_hostRpcCalls).toHaveLength(0);
  });
  it("excludes hidden, archived, deleted and plugin worker threads, not idle threads", async () => {
    const h = setup(5);
    h.rows[1].visibility = "hidden";
    h.rows[2].archivedAt = 123;
    h.rows[3].deletedAt = 123;
    h.rows[4].originPluginId = "workstreams";
    await plugin(h.bb);
    expect((await snapshot(h)).threads.map((t) => t.id)).toEqual(["0"]);
  });
  it("classifies in parallel, reconciles groups, persists results, and never spawns agents", async () => {
    const h = setup();
    await plugin(h.bb);
    await run(h);
    const s = await snapshot(h);
    expect(s.error).toBeNull();
    expect(s.analysis?.items).toHaveLength(17);
    expect(new Set(s.analysis?.items.map((i) => i.group))).toEqual(
      new Set(["Vercel Agent for Slack"]),
    );
    expect(h.peak()).toBe(3);
    // Three classification batches and one workstream summary call.
    expect(
      h.harness.experimental_hostRpcCalls.filter(
        (c) => (c as { method?: string }).method !== "image",
      ),
    ).toHaveLength(4);
    expect(s.analysis?.summaries["Vercel Agent for Slack"]?.about).toBe(
      "About",
    );
    expect(h.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    const reloaded = await h.harness.lifecycle.reload(plugin);
    fixtures.push(reloaded);
    expect(
      ((await reloaded.harness.behavior.callRpc("snapshot", null)) as Snapshot)
        .analysis,
    ).toEqual(s.analysis);
  });
  it("rejects concurrent analysis and preserves previous results after invalid output", async () => {
    const h = setup(2, true);
    await plugin(h.bb);
    const db = h.bb.storage.database();
    const previous = { at: 1, items: [], warnings: [] };
    db.prepare("INSERT INTO state VALUES (?,?)").run(
      "thread-analysis",
      JSON.stringify(previous),
    );
    const replacement = await h.harness.lifecycle.reload(plugin);
    fixtures.push(replacement);
    await replacement.harness.behavior.callRpc("analyze", null);
    await expect(
      replacement.harness.behavior.callRpc("analyze", null),
    ).rejects.toThrow(/already/);
    const service = replacement.harness.behavior.runService("thread-analysis");
    try {
      await expect
        .poll(
          async () =>
            (
              (await replacement.harness.behavior.callRpc(
                "snapshot",
                null,
              )) as Snapshot
            ).progress,
        )
        .toBeNull();
      const s = (await replacement.harness.behavior.callRpc(
        "snapshot",
        null,
      )) as Snapshot;
      expect(s.error).toBeTruthy();
      expect(s.analysis).toEqual({ ...previous, summaries: {} });
    } finally {
      service.controller.abort();
      await service.done;
    }
  });
  it("keeps prior results marked not refreshed when one batch fails", async () => {
    const h = setup(9, false, "Work 8");
    await plugin(h.bb);
    const db = h.bb.storage.database();
    db.prepare("INSERT INTO state VALUES (?,?)").run(
      "thread-analysis",
      JSON.stringify({
        at: 1,
        items: [{ threadId: "8", group: "Old", recap: "Before", updatedAt: 1 }],
        warnings: [],
        summaries: {},
      }),
    );
    const replacement = await h.harness.lifecycle.reload(plugin);
    fixtures.push(replacement);
    await replacement.harness.behavior.callRpc("analyze", null);
    const service = replacement.harness.behavior.runService("thread-analysis");
    const read = async () =>
      (await replacement.harness.behavior.callRpc(
        "snapshot",
        null,
      )) as Snapshot;
    try {
      await expect.poll(async () => (await read()).progress).toBeNull();
      const s = await read();
      expect(s.error).toBeNull();
      expect(s.analysis?.items).toHaveLength(9);
      expect(s.analysis?.items.find((i) => i.threadId === "8")).toMatchObject({
        group: "Old",
        refreshed: false,
      });
      expect(s.analysis?.stats).toMatchObject({ calls: 4, failedCalls: 2 });
      expect(s.analysis?.warnings).toHaveLength(1);
    } finally {
      service.controller.abort();
      await service.done;
    }
  });
  it("cancels a queued analysis without changing results", async () => {
    const h = setup(2);
    await plugin(h.bb);
    await h.harness.behavior.callRpc("analyze", null);
    expect(await h.harness.behavior.callRpc("cancel", null)).toEqual({
      ok: true,
    });
    const s = await snapshot(h);
    expect(s.progress).toBeNull();
    expect(s.error).toMatch(/cancelled/);
    expect(s.analysis).toBeNull();
    expect(h.harness.experimental_hostRpcCalls).toHaveLength(0);
  });
  it("collects initial request events even when prompt history is empty", async () => {
    const h = setup(1);
    h.harness.sdk.stub("threads.events.list", async () => [
      {
        type: "client/turn/requested",
        data: { input: [{ type: "text", text: "Initial product intent" }] },
      },
    ]);
    await plugin(h.bb);
    await run(h);
    expect(JSON.stringify(h.harness.experimental_hostRpcCalls)).toContain(
      "Initial product intent",
    );
    const calls = JSON.stringify(
      h.harness.inspection.sdk.callsTo("threads.events.list"),
    );
    expect(calls).toContain('"order":"asc"');
    expect(calls).toContain('"limit":"100"');
  });
  it("keeps every thread visible when context is unavailable", async () => {
    const h = setup(2);
    h.harness.sdk.stub("threads.promptHistory", async () => {
      throw new Error("missing");
    });
    await plugin(h.bb);
    await run(h);
    const s = await snapshot(h);
    expect(s.analysis?.items).toHaveLength(2);
    expect(s.analysis?.warnings).toHaveLength(2);
  });
  it("does not make model calls with an empty inventory", async () => {
    const h = setup(0);
    await plugin(h.bb);
    await run(h);
    expect((await snapshot(h)).analysis?.items).toEqual([]);
    expect(h.harness.experimental_hostRpcCalls).toHaveLength(0);
  });
});

describe("classification contracts", () => {
  it("requires each thread exactly once and rejects invented IDs", () => {
    const item = {
      threadId: "1",
      group: "BB",
      title: "Build the plugin",
      recap: "Build the plugin",
      state: "done",
    };
    expect(
      parseClassifications(JSON.stringify({ items: [item] }), ["1"]),
    ).toEqual([{ ...item, needsYou: false }]);
    for (const items of [[], [item, item], [{ ...item, threadId: "other" }]])
      expect(() =>
        parseClassifications(JSON.stringify({ items }), ["1"]),
      ).toThrow();
  });
  it("uses fixed non-reasoning Gateway inference with tools and ambient resources disabled", () => {
    expect(MODEL).toBe("openai/gpt-4.1-mini");
    expect(inferenceArgs).toEqual(
      expect.arrayContaining([
        "vercel-ai-gateway",
        MODEL,
        "off",
        "--no-tools",
        "--no-extensions",
        "--no-context-files",
        "--no-skills",
        "--no-session",
      ]),
    );
  });
  it("maps reordered short model IDs back to the correct BB threads", async () => {
    const contexts = ["thr_long_a", "thr_long_b"].map((id) => ({
      id,
      title: id,
      project: "Personal",
      repository: null,
      path: null,
      updatedAt: 1,
      sectionId: null,
      status: "idle",
      excerpts: "",
      timeline: "",
    }));
    const result = await classifyBatch(contexts, async (prompt) => {
      const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      expect(data.map((t: { id: string }) => t.id)).toEqual(["1", "2"]);
      return JSON.stringify({
        items: [
          {
            threadId: "2",
            group: "BB",
            title: "Second thread",
            recap: "Pending",
            state: "needs_decision",
          },
          {
            threadId: "1",
            group: "Workstreams",
            title: "First thread",
            recap: "Ready",
            state: "done",
          },
        ],
      });
    });
    expect(result.map((i) => [i.threadId, i.group])).toEqual([
      ["thr_long_b", "BB"],
      ["thr_long_a", "Workstreams"],
    ]);
  });
  it("normalizes spelling without merging plugins, hosts, or different products", () => {
    const names = [
      "Workstreams",
      "workstreams",
      "Sidebar Hierarchy",
      "sidebar-hierarchy",
      "Ember",
      "ember-changeset",
      "BB",
      "BB Recap",
      "Vercel Agent for Slack",
      "v0",
      "Unclassified",
    ];
    const input = names.map((group, i) => ({
      threadId: String(i),
      group,
      title: `Thread ${i}`,
      recap: `Recap ${i}`,
    }));
    const result = normalizeGroups(input);
    expect(result.map((i) => i.group)).toEqual([
      "Workstreams",
      "Workstreams",
      "Sidebar Hierarchy",
      "Sidebar Hierarchy",
      ...names.slice(4),
    ]);
    expect(result.map(({ group, ...item }) => item)).toEqual(
      input.map(({ group, ...item }) => item),
    );
    expect(input[1].group).toBe("workstreams");
  });
  it("strips packaging descriptors but keeps product qualifiers", () => {
    expect(
      [
        "Sidebar Hierarchy Plugin",
        "bb-plugin-fx-provider",
        "BB - Okta Local Network Auth",
        "BB Plugin: Dynamic Environment",
        "Workstreams bb plugin",
        "BB Recap",
        "Plugin",
      ].map(cleanGroupName),
    ).toEqual([
      "Sidebar Hierarchy",
      "fx-provider",
      "BB",
      "Dynamic Environment",
      "Workstreams",
      "BB Recap",
      "Plugin",
    ]);
  });
  it("retains stopping context at the end of long reports", () => {
    const result = excerpt("Intent" + "x".repeat(4000) + "Blocked on SDK", 100);
    expect(result.startsWith("Intent")).toBe(true);
    expect(result.endsWith("Blocked on SDK")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(100);
  });
  it("rejects missing display titles and clips overlong recaps", () => {
    const item = {
      threadId: "1",
      group: "BB",
      recap: "Waiting",
      state: "done",
    };
    expect(() =>
      parseClassifications(JSON.stringify({ items: [item] }), ["1"]),
    ).toThrow();
    const [clipped] = parseClassifications(
      JSON.stringify({
        items: [{ ...item, title: "Fix BB", recap: "word ".repeat(60) }],
      }),
      ["1"],
    );
    expect(clipped.recap.length).toBeLessThanOrEqual(180);
    expect(clipped.recap.endsWith("…")).toBe(true);
  });
  it("bounds concurrency and retains input order", async () => {
    let active = 0,
      peak = 0;
    const result = await mapConcurrent([0, 1, 2, 3, 4, 5, 6], async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });
    expect(peak).toBe(4);
    expect(result).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it("shows newly added threads and flags changed threads instead of hiding them", () => {
    const s: Snapshot = {
      threads: [
        {
          id: "1",
          title: "One",
          project: "Repo",
          repository: null,
          status: "idle",
          updatedAt: 2,
          sectionId: null,
        },
        {
          id: "2",
          title: "Two",
          project: "Personal",
          repository: null,
          status: "idle",
          updatedAt: 2,
          sectionId: null,
        },
      ],
      analysis: {
        at: 1,
        items: [
          {
            threadId: "1",
            group: "Product",
            recap: "Build",
            updatedAt: 1,
            refreshed: true,
          },
        ],
        warnings: [],
        summaries: {},
      },
      error: null,
      progress: null,
      fixture: null,
    };
    const groups = new Map(groupThreads(s));
    expect(groups.get("Product")?.[0].freshness).toBe("changed");
    expect(groups.get("Personal")?.[0].freshness).toBe("new");
    expect(groups.get("Personal")?.[0].recap).toBeNull();
  });
});
