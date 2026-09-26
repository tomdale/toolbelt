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
  sectionId: null,
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

const fixtures: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.harness.lifecycle.dispose();
});
function host() {
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
        compact: async () => ({ ok: true }),
        archive: async () => ({ ok: true }),
        fork: async () => ({ ...rows[0], id: "fork" }),
        events: {
          list: async () => [
            {
              seq: 20,
              data: { input: [{ type: "text", text: "[bb system] note" }] },
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
  // Hand-made sections left without active threads are removed.
  expect(sdk.callsTo("threadSections.delete")).toEqual([[{ id: "sec_old" }]]);
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
