import { afterEach, describe, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

type State = {
  status: string;
  roots: { id: string; provenance: string }[];
  changes: { id: string; kind: string; accepted: boolean }[];
  preview: {
    creates: { name: string }[];
    moves: {
      threadId: string;
      to: string;
      toName: string;
      accepted: boolean;
      confidence?: string;
    }[];
    unsure: { threadId: string }[];
  } | null;
  entryId: string | null;
};

/** Assignments keyed by thread id; the map proposal creates "Gamma". */
function model(assign: Record<string, string>) {
  return ({ prompt }: { prompt: string }) => {
    if (prompt.includes("You are tidying"))
      return JSON.stringify({
        descriptions: { Alpha: "Alpha things." },
        changes: [
          {
            kind: "rename",
            workstream: "Beta",
            name: "Beta Prime",
            reason: "clearer",
          },
          { kind: "create", name: "Gamma", description: "Gamma things." },
        ],
      });
    if (prompt.includes("File each thread under")) {
      const ids = [...prompt.matchAll(/id "([^"]+)"/g)].map((m) => m[1]!);
      return JSON.stringify({
        items: ids.map((id) => ({
          id,
          workstream: assign[id] ?? "unsure",
          confidence: "high",
        })),
      });
    }
    return JSON.stringify({ recap: "r", state: "done", subject: null });
  };
}

const call = async (w: World, input: unknown) =>
  (
    (await w.harness.behavior.callRpc("bootstrap", input)) as {
      state: State | null;
      bootstrapped: boolean;
    }
  ).state!;
const settle = async (w: World, status: string) => {
  for (let i = 0; i < 100; i++) {
    const state = await call(w, { action: "get" });
    if (state?.status === status) return state;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`never reached ${status}`);
};

async function organized(settings: Record<string, boolean> = {}) {
  world = await fakeWorld({
    settings,
    complete: model({
      loose: "Alpha",
      v1auto: "Gamma",
      loose2: "Gamma",
      mine: "Alpha",
    }),
  });
  const w = world;
  const alpha = w.addSection("Alpha");
  const beta = w.addSection("Beta");
  w.addThread("a1", { sectionId: alpha.id });
  w.addThread("loose");
  w.addThread("loose2");
  w.addThread("v1auto", { sectionId: beta.id });
  w.addThread("mine", { sectionId: beta.id });
  w.addThread("kid", { parentThreadId: "mine" });
  // v1's organize log says v1 filed "v1auto" into Beta automatically.
  w.bb.storage
    .database()
    .prepare("INSERT INTO state (key, value) VALUES ('organize-log', ?)")
    .run(
      JSON.stringify([
        {
          action: { kind: "section", threadId: "v1auto", section: "Beta" },
          result: "done",
          undone: false,
          undo: { workstreamsSectionId: beta.id },
        },
      ]),
    );
  await w.harness.behavior.callRpc("refresh", null);
  return { w, alpha, beta };
}

describe("bootstrap", () => {
  it("leaves model-proposed workstream merges unchecked", async () => {
    world = await fakeWorld({
      complete: ({ prompt }) =>
        prompt.includes("You are tidying")
          ? JSON.stringify({
              descriptions: {},
              changes: [
                {
                  kind: "merge",
                  workstream: "Workstreams",
                  into: "BB & plugins",
                  reason: "Both touch BB",
                },
              ],
            })
          : JSON.stringify({
              recap: "Working.",
              state: "in_progress",
              subject: "Workstreams",
            }),
    });
    const specific = world.addSection("Workstreams");
    world.addSection("BB & plugins");
    world.addThread("specific", { sectionId: specific.id });
    await call(world, { action: "start" });
    const review = (await settle(world, "review")) as State & {
      changes: { kind: string; accepted: boolean }[];
    };
    expect(
      review.changes.find((change) => change.kind === "merge")?.accepted,
    ).toBe(false);
  });

  it("reviews, previews, and applies as one batch, leaving user filings alone", async () => {
    const { w, alpha, beta } = await organized();
    await call(w, { action: "start" });
    let state = await settle(w, "review");
    expect(
      Object.fromEntries(state.roots.map((r) => [r.id, r.provenance])),
    ).toEqual({
      a1: "user",
      loose: "unfiled",
      loose2: "unfiled",
      v1auto: "auto",
      mine: "user",
    });
    expect(state.changes.map((c) => c.kind)).toEqual(["rename", "create"]);
    // Nothing changes in BB before apply.
    expect(w.sections.map((s) => s.name)).toEqual(["Alpha", "Beta"]);

    await call(w, {
      action: "assign",
      decisions: state.changes.map((c) => ({ id: c.id, accepted: true })),
    });
    state = await settle(w, "preview");
    const moves = Object.fromEntries(
      state.preview!.moves.map((m) => [m.threadId, m.toName]),
    );
    expect(moves).toEqual({ loose: "Alpha", loose2: "Gamma", v1auto: "Gamma" });
    expect(state.preview!.moves.some((m) => m.threadId === "mine")).toBe(false);
    // The preview shows confidence without parsing the CLI's reason text.
    expect(state.preview!.moves.map((m) => m.confidence)).toEqual([
      "high",
      "high",
      "high",
    ]);
    expect(
      state.preview!.moves.find((m) => m.threadId === "v1auto")?.accepted,
    ).toBe(false);

    await call(w, { action: "apply", overrides: [] });
    state = await settle(w, "applied");
    const gamma = w.sections.find((s) => s.name === "Gamma")!;
    expect(w.sections.find((s) => s.id === beta.id)?.name).toBe("Beta Prime");
    expect(w.threads.get("loose")?.sectionId).toBe(alpha.id);
    expect(w.threads.get("v1auto")?.sectionId).toBe(beta.id);
    expect(w.threads.get("mine")?.sectionId).toBe(beta.id);
    expect(w.threads.get("kid")?.sectionId).toBeNull();
    expect(
      (
        (await w.harness.behavior.callRpc("state", null)) as {
          bootstrapped: boolean;
        }
      ).bootstrapped,
    ).toBe(true);

    // Undo reverts the whole batch, including the new workstream and rename.
    await w.harness.behavior.callRpc("undo", { entryId: state.entryId });
    expect(w.threads.get("loose")?.sectionId).toBeNull();
    expect(w.threads.get("v1auto")?.sectionId).toBe(beta.id);
    expect(w.sections.map((s) => s.name).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("applies only the moves left checked", async () => {
    const { w } = await organized();
    await call(w, { action: "start" });
    const review = await settle(w, "review");
    await call(w, {
      action: "assign",
      decisions: review.changes.map((c) => ({
        id: c.id,
        accepted: c.kind !== "rename",
      })),
    });
    await settle(w, "preview");
    await call(w, {
      action: "apply",
      overrides: [{ threadId: "loose", accepted: false }],
    });
    await settle(w, "applied");
    expect(w.threads.get("loose")?.sectionId).toBeNull();
    expect(w.sections.some((s) => s.name === "Beta Prime")).toBe(false);
    // Evolution, now on, respects the unchecked move.
    await w.harness.behavior.runCli(["analyze", "loose"]);
    await w.harness.behavior.callRpc("refresh", null);
    expect(w.threads.get("loose")?.sectionId).toBeNull();
  });

  it("previews from the CLI without changing anything", async () => {
    const { w } = await organized();
    const result = await w.harness.behavior.runCli(["rebuild"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      /^Preview: 2 moves, 1 new workstream, 1 rename/,
    );
    expect(w.threads.get("loose")?.sectionId).toBeNull();
  });
});

describe("cutover", () => {
  it("removes v1 data only after organizing, and only with --yes", async () => {
    const { w } = await organized();
    expect(
      (await w.harness.behavior.runCli(["cutover", "--yes"])).exitCode,
    ).not.toBe(0);
    await w.harness.behavior.callRpc("bootstrap", { action: "skip" });
    const preview = await w.harness.behavior.runCli(["cutover"]);
    expect(preview.stdout).toContain("Would remove v1 data: 1 state rows");
    await w.harness.behavior.runCli(["cutover", "--yes"]);
    const rows = w.bb.storage
      .database()
      .prepare("SELECT COUNT(*) AS n FROM state")
      .get() as { n: number };
    expect(rows.n).toBe(0);
    // Everything else keeps working.
    expect((await w.harness.behavior.runCli(["list"])).exitCode).toBe(0);
  });
});

describe("debug traces", () => {
  it("keeps the run's model calls with the run, each move, and the applied batch", async () => {
    const { w } = await organized({ debug: true });
    await call(w, { action: "start" });
    const review = (await settle(w, "review")) as State & {
      traceIds: string[];
    };
    expect(review.traceIds).toHaveLength(1);
    await call(w, {
      action: "assign",
      decisions: review.changes.map((c) => ({ id: c.id, accepted: true })),
    });
    const preview = (await settle(w, "preview")) as State & {
      traceIds: string[];
      preview: { moves: { traceId?: string | null }[] };
    };
    expect(preview.traceIds.length).toBeGreaterThan(1);
    for (const move of preview.preview.moves)
      expect(preview.traceIds).toContain(move.traceId);
    await call(w, { action: "apply", overrides: [] });
    const applied = await settle(w, "applied");
    const { entries } = (await w.harness.behavior.callRpc("journal", {})) as {
      entries: { id: string; traceIds: string[] }[];
    };
    const batch = entries.find((e) => e.id === applied.entryId)!;
    expect([...batch.traceIds].sort()).toEqual([...preview.traceIds].sort());
  });
});
