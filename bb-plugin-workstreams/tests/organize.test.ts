import { afterEach, expect, it } from "vitest";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { type View } from "../server";
import { messyTitle, planOrganize } from "../organize";
import type { Analysis } from "../model";

const drift = (confidence: "high" | "medium") => ({
  from: "Lumen",
  to: "Markdown viewer",
  mainlineTitle: "Lumen build caching",
  sideTitle: "Markdown viewer themes",
  splitSeq: 30,
  confidence,
});
const thread = (
  id: string,
  title = `Work ${id}`,
  sectionName: string | null = null,
) => ({
  id,
  title,
  project: "p",
  repository: null,
  status: "idle",
  updatedAt: 1,
  latestAttentionAt: 1,
  sectionId: null,
  parentThreadId: null,
  environmentPath: null,
  hasPendingInteraction: false,
  sectionName,
});
const analysis = (items: Partial<Analysis["items"][number]>[]): Analysis => ({
  at: 1,
  needsYouCount: 0,
  warnings: [],
  summaries: {},
  items: items.map((i) => ({
    threadId: "a",
    group: "Lumen",
    recap: "r",
    title: "Tidy title",
    updatedAt: 1,
    refreshed: true,
    ...i,
  })),
});

it("does not plan a split after the thread changes since analysis", () => {
  expect(
    planOrganize(
      [thread("a")],
      analysis([
        {
          threadId: "a",
          group: "Markdown viewer",
          updatedAt: 0,
          drift: drift("high"),
        },
      ]),
      new Set(),
    ),
  ).toEqual([]);
});

it("plans high-confidence splits, messy-title renames, and section moves", () => {
  const actions = planOrganize(
    [
      thread("a"),
      thread(
        "b",
        "check out https://github.com/x/y and fix the thing please...",
      ),
      thread("c", "Fine title", "Lumen"),
      thread("d"),
      thread("e"),
    ],
    analysis([
      { threadId: "a", group: "Markdown viewer", drift: drift("high") },
      { threadId: "b" },
      { threadId: "c", drift: drift("medium") },
      { threadId: "d", updatedAt: 0 },
      { threadId: "e", group: "Unclassified" },
    ]),
    new Set(),
  );
  expect(actions.map((a) => [a.kind, a.threadId])).toEqual([
    ["split", "a"],
    ["section", "a"],
    ["retitle", "b"],
    ["section", "b"],
  ]);
  expect(
    planOrganize(
      [thread("a")],
      analysis([{ threadId: "a", drift: drift("high") }]),
      new Set(["a"]),
    ).map((a) => a.kind),
  ).toEqual(["section"]);
  expect(messyTitle("Fix the Lumen cache")).toBe(false);
  expect(messyTitle("Explain…")).toBe(true);
});

it("repairs worker parentage beneath an explicitly titled manager", () => {
  const manager = thread("manager", "Vercel Agent — manager");
  const worker = {
    ...thread("worker", "Alert investigation"),
    parentThreadId: "manager",
  };
  const other = thread("other", "Standalone tomdaleOS thread");
  const actions = planOrganize(
    [manager, worker, other],
    analysis([
      { threadId: "manager", group: "Vercel Agent" },
      { threadId: "worker", group: "Vercel Agent: alerts" },
      { threadId: "other", group: "tomdaleOS" },
    ]),
    new Set(),
  );
  expect(actions.filter((action) => action.kind === "parent")).toEqual([]);
});

it("archives only explicitly redundant completed threads", () => {
  expect(
    planOrganize(
      [thread("done"), thread("in-progress")],
      analysis([
        {
          threadId: "done",
          state: "done",
          archiveReason: "Duplicate; work continues in thread abc",
        },
        {
          threadId: "in-progress",
          state: "in_progress",
          archiveReason: "Duplicate; work continues elsewhere",
        },
      ]),
      new Set(),
    ).filter((action) => action.kind === "archive"),
  ).toEqual([
    {
      kind: "archive",
      threadId: "done",
      reason: "Duplicate; work continues in thread abc",
    },
  ]);
});

const fixtures: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.harness.lifecycle.dispose();
});
function host(
  options: {
    forkFails?: boolean;
    compactFails?: boolean;
    missingPivot?: boolean;
  } = {},
) {
  const rows = [
    makeThreadResponse({
      id: "a",
      projectId: "p",
      title: "Explain Lumen caching",
      environmentId: "env",
      status: "idle",
    }),
  ];
  const h = createFakePluginHost({
    pluginId: "workstreams",
    sdk: {
      projects: {
        list: async () => [
          { id: "p", name: "P", kind: "personal", gitRemoteUrl: null },
        ],
      },
      environments: {
        get: async () => ({ id: "env", path: null }),
      },
      threadSections: {
        delete: async () => ({ id: "sec_old", name: "Old" }),
        list: async () => [{ id: "sec_old", name: "Old" }],
        create: async ({ name }: { name: string }) => ({
          id: `sec_${name}`,
          name,
        }),
      },
      threads: {
        list: async () => rows,
        get: async () => rows[0],
        update: async () => rows[0],
        compact: async () => {
          if (options.compactFails) throw new Error("compact unavailable");
          return { ok: true };
        },
        archive: async () => ({ ok: true }),
        unarchive: async () => ({ ok: true }),
        childSummary: async () => ({ nonDeletedChildCount: 0 }),
        fork: async () => {
          if (options.forkFails) throw new Error("fork unavailable");
          return { ...rows[0], id: "fork" };
        },
        events: {
          list: async ({ afterSeq }: { afterSeq?: string }) =>
            afterSeq
              ? [
                  {
                    seq: options.missingPivot ? 31 : 30,
                    data: {
                      input: [
                        { type: "text", text: "Switch to Markdown viewer" },
                      ],
                    },
                  },
                ]
              : [
                  {
                    seq: 20,
                    data: {
                      input: [{ type: "text", text: "[bb system] note" }],
                    },
                  },
                  {
                    seq: 12,
                    data: { input: [{ type: "text", text: "remote cache?" }] },
                  },
                ],
        },
      },
    },
  });
  fixtures.push(h);
  return { ...h, rows };
}
async function seed(h: ReturnType<typeof host>, updatedAt: number) {
  h.bb.storage
    .database()
    .prepare("INSERT INTO state VALUES (?,?)")
    .run(
      "thread-analysis",
      JSON.stringify(
        analysis([
          {
            threadId: "a",
            group: "Markdown viewer",
            title: "Markdown viewer themes",
            updatedAt,
            drift: drift("high"),
          },
        ]),
      ),
    );
}

it("splits a side quest, logs it, and undoes it", async () => {
  const h = host();
  await plugin(h.bb);
  await seed(h, h.rows[0].updatedAt);
  const live = await h.harness.lifecycle.reload(plugin);
  fixtures.push(live);
  const call = live.harness.behavior.callRpc;
  await call("organize", null);
  const sdk = live.harness.inspection.sdk;
  const [[fork]] = sdk.callsTo("threads.fork") as unknown[][];
  expect(fork).toMatchObject({
    sourceThreadId: "a",
    sourceSeqEnd: 12,
    title: "Lumen build caching",
    environment: { type: "reuse", environmentId: "env" },
  });
  expect(JSON.stringify(sdk.callsTo("threads.update"))).toContain(
    "Markdown viewer themes",
  );
  expect(sdk.callsTo("threads.compact")).toHaveLength(1);
  expect(sdk.callsTo("threadSections.delete")).toHaveLength(0);
  const view = (await call("snapshot", null)) as View;
  const split = view.log.find((e) => e.action.kind === "split")!;
  expect(split).toMatchObject({
    result: "done",
    undo: { forkId: "fork", title: "Explain Lumen caching" },
  });
  await call("undo", { id: split.id });
  expect(sdk.callsTo("threads.archive")).toEqual([
    [expect.objectContaining({ threadId: "fork" })],
  ]);
  expect(JSON.stringify(sdk.callsTo("threads.update").at(-1))).toContain(
    "Explain Lumen caching",
  );
  // A split already performed is not repeated by the next pass unless undone.
  await call("organize", null);
  expect(sdk.callsTo("threads.fork")).toHaveLength(2);
});

it.each([
  ["manual empty", null],
  ["archived-only", { archivedAt: 123 }],
  ["hidden-only", { visibility: "hidden" }],
] as const)(
  "preserves a %s native section during organize",
  async (_label, state) => {
    const h = host();
    if (state)
      h.rows.push(
        Object.assign(
          makeThreadResponse({
            id: "other",
            projectId: "p",
            title: "Other work",
            environmentId: "env",
            status: "idle",
          }),
          { sectionId: "sec_old", ...state },
        ),
      );
    await plugin(h.bb);
    h.bb.storage
      .database()
      .prepare("INSERT INTO state VALUES (?,?)")
      .run(
        "thread-analysis",
        JSON.stringify(
          analysis([
            {
              threadId: "a",
              group: "Markdown viewer",
              updatedAt: h.rows[0].updatedAt,
            },
          ]),
        ),
      );
    const live = await h.harness.lifecycle.reload(plugin);
    fixtures.push(live);
    await live.harness.behavior.callRpc("organize", null);
    const sdk = live.harness.inspection.sdk;
    expect(sdk.callsTo("threads.update")).toContainEqual([
      { threadId: "a", sectionId: "sec_Markdown viewer" },
    ]);
    expect(sdk.callsTo("threadSections.delete")).toHaveLength(0);
    const view = (await live.harness.behavior.callRpc(
      "snapshot",
      null,
    )) as View;
    expect(view.log.map((entry) => entry.action.kind)).toEqual(["section"]);
  },
);
it("rejects direct split RPC for stale, low-confidence, duplicate and failed forks", async () => {
  for (const scenario of [
    "stale",
    "unrefreshed",
    "low",
    "pending",
    "pivot",
    "duplicate",
    "fork-fails",
    "compact-fails",
  ] as const) {
    const h = host({
      forkFails: scenario === "fork-fails",
      compactFails: scenario === "compact-fails",
      missingPivot: scenario === "pivot",
    });
    await plugin(h.bb);
    await seed(h, h.rows[0].updatedAt);
    const db = h.bb.storage.database();
    if (scenario === "unrefreshed" || scenario === "low") {
      const saved = analysis([
        {
          threadId: "a",
          group: "Markdown viewer",
          drift: drift(scenario === "low" ? "medium" : "high"),
          refreshed: scenario !== "unrefreshed",
          updatedAt: h.rows[0].updatedAt,
        },
      ]);
      if (scenario === "low")
        saved.items[0].drift = { ...drift("medium"), confidence: "low" };
      db.prepare("UPDATE state SET value = ? WHERE key = ?").run(
        JSON.stringify(saved),
        "thread-analysis",
      );
    }
    const live = await h.harness.lifecycle.reload(plugin);
    fixtures.push(live);
    if (scenario === "stale") h.rows[0].updatedAt += 1;
    if (scenario === "pending")
      Object.assign(h.rows[0], { hasPendingInteraction: true });
    const call = live.harness.behavior.callRpc;
    if (scenario === "duplicate") {
      expect(await call("split", { threadId: "a" })).toEqual({ ok: true });
    }
    await expect(call("split", { threadId: "a" })).rejects.toThrow();
    const sdk = live.harness.inspection.sdk;
    expect(sdk.callsTo("threads.fork")).toHaveLength(
      scenario === "duplicate" ||
        scenario === "fork-fails" ||
        scenario === "compact-fails"
        ? 1
        : 0,
    );
    expect(sdk.callsTo("threads.compact")).toHaveLength(
      scenario === "duplicate" || scenario === "compact-fails" ? 1 : 0,
    );
    const view = (await call("snapshot", null)) as View;
    expect(view.log.at(-1)?.result).toBe("failed");
    if (scenario === "compact-fails") {
      expect(view.log.at(-1)?.undo?.forkId).toBe("fork");
      await expect(call("split", { threadId: "a" })).rejects.toThrow();
      expect(sdk.callsTo("threads.fork")).toHaveLength(1);
    }
  }
});

it("permits a current medium-confidence manual split but not an automatic one", async () => {
  const h = host();
  await plugin(h.bb);
  await seed(h, h.rows[0].updatedAt);
  h.bb.storage
    .database()
    .prepare("UPDATE state SET value = ? WHERE key = ?")
    .run(
      JSON.stringify(
        analysis([
          {
            threadId: "a",
            group: "Markdown viewer",
            updatedAt: h.rows[0].updatedAt,
            drift: drift("medium"),
          },
        ]),
      ),
      "thread-analysis",
    );
  const live = await h.harness.lifecycle.reload(plugin);
  fixtures.push(live);
  const call = live.harness.behavior.callRpc;
  await call("organize", null);
  expect(live.harness.inspection.sdk.callsTo("threads.fork")).toHaveLength(0);
  expect(await call("split", { threadId: "a" })).toEqual({ ok: true });
  expect(live.harness.inspection.sdk.callsTo("threads.fork")).toHaveLength(1);
});

it("rejects stale high-confidence auto splits without mutating", async () => {
  const h = host();
  await plugin(h.bb);
  await seed(h, h.rows[0].updatedAt);
  const live = await h.harness.lifecycle.reload(plugin);
  fixtures.push(live);
  h.rows[0].updatedAt += 1;
  await live.harness.behavior.callRpc("organize", null);
  expect(live.harness.inspection.sdk.callsTo("threads.fork")).toHaveLength(0);
  const view = (await live.harness.behavior.callRpc("snapshot", null)) as View;
  expect(view.log.some((e) => e.action.kind === "split")).toBe(false);
it("rejects a drifted action and does not stamp failed work current", async () => {
  const h = host();
  await plugin(h.bb);
  const initial = h.rows[0].updatedAt;
  await seed(h, initial);
  const live = await h.harness.lifecycle.reload(plugin);
  fixtures.push(live);
  // Inventory sees the planned revision; the detail lookup before the fork
  // sees an edit that occurred during action planning.
  live.harness.sdk.stub("threads.get", async () => ({
    ...h.rows[0],
    updatedAt: initial + 1,
  }));
  await live.harness.behavior.callRpc("organize", null);
  const sdk = live.harness.inspection.sdk;
  expect(sdk.callsTo("threads.fork")).toHaveLength(0);
  expect(sdk.callsTo("threads.update")).toHaveLength(0);
  const view = (await live.harness.behavior.callRpc("snapshot", null)) as View;
  expect(view.log.find((e) => e.action.kind === "split")).toMatchObject({
    result: "failed",
    detail: "Thread changed since action planning.",
  });
  expect(view.analysis?.items[0]).toMatchObject({
    updatedAt: initial,
    refreshed: false,
  });
});

it("rechecks after archive preflight before the side effect", async () => {
  const h = host();
  await plugin(h.bb);
  const initial = h.rows[0].updatedAt;
  h.bb.storage
    .database()
    .prepare("INSERT INTO state VALUES (?,?)")
    .run(
      "thread-analysis",
      JSON.stringify(
        analysis([
          {
            threadId: "a",
            state: "done",
            archiveReason: "Duplicate thread",
            updatedAt: initial,
          },
        ]),
      ),
    );
  const live = await h.harness.lifecycle.reload(plugin);
  fixtures.push(live);
  let version = initial;
  live.harness.sdk.stub("threads.get", async () => ({
    ...h.rows[0],
    updatedAt: version,
  }));
  live.harness.sdk.stub("threads.childSummary", async () => {
    version++;
    return { nonDeletedChildCount: 0 };
  });
  await live.harness.behavior.callRpc("organize", null);
  expect(live.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(
    0,
  );
  const view = (await live.harness.behavior.callRpc("snapshot", null)) as View;
  expect(view.log.find((e) => e.action.kind === "archive")).toMatchObject({
    result: "failed",
  });
  expect(view.analysis?.items[0]).toMatchObject({
    updatedAt: initial,
    refreshed: false,
  });
});

it("archives a redundant idle thread with undo", async () => {
  const h = host();
  await plugin(h.bb);
  h.bb.storage
    .database()
    .prepare("INSERT INTO state VALUES (?,?)")
    .run(
      "thread-analysis",
      JSON.stringify(
        analysis([
          {
            threadId: "a",
            state: "done",
            archiveReason: "Duplicate; useful work continues in thread other",
            updatedAt: h.rows[0].updatedAt,
          },
        ]),
      ),
    );
  const live = await h.harness.lifecycle.reload(plugin);
  fixtures.push(live);
  await live.harness.behavior.callRpc("organize", null);
  const sdk = live.harness.inspection.sdk;
  expect(sdk.callsTo("threads.archive")).toEqual([[{ threadId: "a" }]]);
  const view = (await live.harness.behavior.callRpc("snapshot", null)) as View;
  const archived = view.log.find((e) => e.action.kind === "archive")!;
  expect(archived).toMatchObject({
    result: "done",
    detail: "Duplicate; useful work continues in thread other",
    undo: { archived: true },
  });
  await live.harness.behavior.callRpc("undo", { id: archived.id });
  expect(sdk.callsTo("threads.unarchive")).toEqual([[{ threadId: "a" }]]);
});

it("only plans actions while replaying a fixture", async () => {
  const h = host();
  await plugin(h.bb);
  const dir = await mkdtemp(join(tmpdir(), "ws-"));
  const path = join(dir, "fixture.json");
  await writeFile(
    path,
    JSON.stringify([
      {
        id: "f",
        title:
          "https://example.com long raw prompt title that goes on and on and on",
        project: "p",
        repository: null,
        status: "idle",
        updatedAt: 1,
        excerpts: "",
        path: null,
      },
    ]),
  );
  const cli = await h.harness.behavior.runCli(["fixture", path]);
  expect(cli.exitCode).toBe(0);
  h.bb.storage
    .database()
    .prepare(
      "INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(
      "fixture-analysis",
      JSON.stringify(analysis([{ threadId: "f", group: "Example" }])),
    );
  const replay = await h.harness.lifecycle.reload(plugin);
  fixtures.push(replay);
  await replay.harness.behavior.callRpc("organize", null);
  const view = (await replay.harness.behavior.callRpc(
    "snapshot",
    null,
  )) as View;
  expect(view.fixture).toBe("fixture.json");
  expect(view.log.map((e) => [e.action.kind, e.result])).toEqual([
    ["retitle", "planned"],
    ["section", "planned"],
  ]);
  expect(replay.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(
    0,
  );
});

it("undoes a section move after its original section was deleted", async () => {
  const h = host();
  await plugin(h.bb);
  const db = h.bb.storage.database();
  db.prepare("INSERT INTO state VALUES (?,?)").run(
    "thread-analysis",
    JSON.stringify(analysis([{ threadId: "a", group: "Markdown viewer" }])),
  );
  db.prepare("INSERT INTO state VALUES (?,?)").run(
    "organize-log",
    JSON.stringify([
      {
        id: "move-1",
        at: 1,
        needsYouCount: 0,
        action: { kind: "section", threadId: "a", section: "Markdown viewer" },
        result: "done",
        detail: "",
        undo: {
          title: "Explain Lumen caching",
          sectionId: "deleted-section",
          sectionName: "Lumen",
        },
        undone: false,
      },
    ]),
  );
  const replay = await h.harness.lifecycle.reload(plugin);
  fixtures.push(replay);
  await replay.harness.behavior.callRpc("undo", { id: "move-1" });
  const updates = replay.harness.inspection.sdk.callsTo("threads.update");
  expect(updates.at(-1)).toMatchObject([
    { threadId: "a", sectionId: "sec_Lumen" },
  ]);
  expect(
    replay.harness.inspection.sdk.callsTo("threadSections.create"),
  ).toEqual([[{ name: "Lumen" }]]);
});
