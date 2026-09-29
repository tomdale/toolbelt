import { afterEach, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import type { AnalysisDiagnostics, GroupingReport } from "../diagnostics";

// Synthetic content markers: diagnostics must never store or print them.
const TITLE = "PRIVATE-TITLE";
const REQUEST = "PRIVATE-REQUEST";
const REPORT = "PRIVATE-REPORT";

const fixtures: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.harness.lifecycle.dispose();
});

function setup(settings: Record<string, boolean | string> = {}) {
  const rows = [
    // Manually filed into the shared section (no Workstreams log entry), so
    // collection pins it there whatever the model says.
    makeThreadResponse({
      id: "pinned",
      projectId: "p",
      title: `${TITLE} pinned`,
      environmentId: null,
      status: "idle",
      sectionId: "sec_shared",
    }),
    makeThreadResponse({
      id: "shared",
      projectId: "p",
      title: `${TITLE} shared`,
      environmentId: null,
      status: "idle",
    }),
    makeThreadResponse({
      id: "plugin",
      projectId: "p",
      title: `${TITLE} plugin`,
      environmentId: null,
      status: "idle",
    }),
  ];
  const prompts: string[] = [];
  const h = createFakePluginHost({
    pluginId: "workstreams",
    settings,
    sdk: {
      projects: {
        list: async () => [
          {
            id: "p",
            name: "Home Ops",
            kind: "personal",
            gitRemoteUrl: "git@github.com:someone/home-ops.git",
          },
        ],
      },
      threadSections: {
        list: async () => [{ id: "sec_shared", name: "Home Ops" }],
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
        list: async () => rows,
        get: async ({ threadId }: { threadId: string }) =>
          rows.find((t) => t.id === threadId)!,
        update: async ({ threadId }: { threadId: string }) =>
          rows.find((t) => t.id === threadId)!,
        events: {
          list: async () => [
            {
              type: "client/turn/requested",
              seq: 1,
              data: { input: [{ type: "text", text: REQUEST }] },
            },
          ],
        },
        promptHistory: async () => [],
        output: async () => ({ output: REPORT }),
      },
    },
    experimental_callHostRpc: async ({ input }) => {
      const prompt = (input as { prompt: string }).prompt;
      prompts.push(prompt);
      const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      if (prompt.includes("about: at most 90 characters"))
        return {
          text: JSON.stringify({
            groups: data.map((g: { name: string }) => ({
              name: g.name,
              about: "About",
              status: "Status",
              needsYou: 0,
              motif: "Motif",
            })),
          }),
          usage: { input: 1, output: 1, cost: 0 },
        };
      const basis = prompt.includes('"basis"');
      return {
        text: JSON.stringify({
          items: data.map((t: { id: string; title: string }) => ({
            threadId: t.id,
            group: t.title.endsWith("plugin")
              ? "Lumen plugin"
              : t.title.endsWith("shared")
                ? "home-ops"
                : "Lumen",
            title: "Model title",
            recap: "Model recap",
            state: "in_progress",
            ...(basis ? { basis: "checkout_path" } : {}),
          })),
        }),
        usage: { input: 1, output: 1, cost: 0 },
      };
    },
  });
  fixtures.push(h);
  return { ...h, rows, prompts };
}

async function analyze(h: ReturnType<typeof setup>, argv: string[]) {
  expect((await h.harness.behavior.runCli(["analyze", ...argv])).exitCode).toBe(
    0,
  );
  const service = h.harness.behavior.runService("thread-analysis");
  try {
    await expect
      .poll(
        async () =>
          (
            (await h.harness.behavior.callRpc("snapshot", null)) as {
              progress: unknown;
              organizing: boolean;
            }
          ).progress,
        { timeout: 3000 },
      )
      .toBeNull();
  } finally {
    service.controller.abort();
    await service.done;
  }
}
const stored = (h: ReturnType<typeof setup>, key: string) =>
  (
    h.bb.storage
      .database()
      .prepare("SELECT value FROM state WHERE key = ?")
      .get(key) as { value: string } | undefined
  )?.value;
async function diagnose(h: ReturnType<typeof setup>, argv: string[] = []) {
  const result = await h.harness.behavior.runCli(["diagnose", ...argv]);
  expect(result.exitCode).toBe(0);
  return {
    text: result.stdout,
    report: JSON.parse(result.stdout) as {
      classifierIsCurrent: boolean | null;
      classifier: AnalysisDiagnostics | null;
      organize: { decisions: { threadId: string; notes: string[] }[] } | null;
      plan: { actions: Record<string, number> };
      grouping: GroupingReport;
    },
  };
}

it("records nothing extra and leaves the prompt unchanged by default", async () => {
  const h = setup({ organize: "suggest" });
  await plugin(h.bb);
  await analyze(h, []);
  expect(h.prompts.some((p) => p.includes('"basis"'))).toBe(false);
  expect(stored(h, "analysis-diagnostics")).toBeUndefined();
  const { report } = await diagnose(h);
  expect(report.classifier).toBeNull();
  expect(report.classifierIsCurrent).toBeNull();
  // Grouping and plan explanations work without a recorded trace.
  expect(report.grouping.threads.map((t) => t.threadId).sort()).toEqual([
    "pinned",
    "plugin",
    "shared",
  ]);
  expect(report.plan.actions).toEqual({ section: 2 });
});

it("traces a diagnosed run through model output, pins, and cleanup without content", async () => {
  const h = setup({ organize: "suggest" });
  await plugin(h.bb);
  await analyze(h, ["--diagnose"]);
  const raw = stored(h, "analysis-diagnostics")!;
  for (const marker of [TITLE, REQUEST, REPORT, "Model title", "Model recap"])
    expect(raw).not.toContain(marker);
  const { text, report } = await diagnose(h);
  expect(text).not.toContain(TITLE);
  expect(report.classifierIsCurrent).toBe(true);
  const traces = new Map(
    report.classifier!.threads.map((t) => [t.threadId, t]),
  );
  expect(traces.get("pinned")).toMatchObject({
    input: {
      project: "Home Ops",
      repository: "home-ops",
      pinnedGroup: "Home Ops",
      pinSource: "section",
      hasInitialRequest: true,
      hasAssistantReport: true,
    },
    model: {
      group: "Lumen",
      basis: "checkout_path",
      equalsProject: false,
      titleChanged: true,
    },
    steps: [{ stage: "pin", from: "Lumen", to: "Home Ops" }],
    outcome: "classified",
    finalGroup: "Home Ops",
  });
  expect(traces.get("plugin")).toMatchObject({
    model: { group: "Lumen plugin" },
    steps: [{ stage: "clean", from: "Lumen plugin", to: "Lumen" }],
    finalGroup: "Lumen",
  });
  // Structural evidence of the project-name fallback, independent of basis;
  // the spelling then merges into the pinned thread's group.
  expect(traces.get("shared")).toMatchObject({
    model: { group: "home-ops", equalsProject: true },
    steps: [{ stage: "merge", from: "home-ops", to: "Home Ops" }],
    finalGroup: "Home Ops",
  });
  expect(report.classifier!.batches).toEqual([
    {
      batch: 0,
      threads: 3,
      attempts: [{ ok: true, error: null }],
      driftCheckFailed: false,
    },
  ]);
  const logged = h.harness.inspection.logEntries.find((e) =>
    String(e.message).startsWith("Workstreams diagnostics"),
  );
  expect(logged).toBeDefined();
  expect(JSON.stringify(logged)).not.toContain(TITLE);
  // Titles appear only on explicit request, read live and redacted.
  const titled = await diagnose(h, ["--thread", "plugin", "--titles"]);
  expect(titled.report.grouping.threads).toMatchObject([
    { threadId: "plugin", title: `${TITLE} plugin` },
  ]);
  expect(titled.report.classifier!.threads.map((t) => t.threadId)).toEqual([
    "plugin",
  ]);
});

it("records organize decisions when the diagnostics setting is on", async () => {
  const h = setup({ diagnostics: true });
  await plugin(h.bb);
  await analyze(h, []);
  expect(h.prompts.some((p) => p.includes('"basis"'))).toBe(true);
  const { report } = await diagnose(h);
  expect(report.organize!.decisions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        threadId: "pinned",
        notes: ["already-in-section"],
      }),
      expect.objectContaining({ threadId: "plugin", planned: ["section"] }),
    ]),
  );
});

it("diagnoses without mutating threads or sections", async () => {
  const h = setup();
  await plugin(h.bb);
  await diagnose(h);
  await h.harness.behavior.callRpc("diagnostics", { group: "Home Ops" });
  for (const method of [
    "threads.update",
    "threadSections.create",
    "threads.archive",
    "threads.fork",
  ])
    expect(h.harness.inspection.sdk.callsTo(method)).toHaveLength(0);
  expect(
    (await h.harness.behavior.runCli(["diagnose", "--thread"])).exitCode,
  ).toBe(1);
});
