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
  changes: { id: string; kind: string }[];
  preview: {
    creates: { name: string }[];
    moves: {
      threadId: string;
      to: string;
      toName: string;
      accepted: boolean;
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

async function organized() {
  world = await fakeWorld({
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

    await call(w, { action: "apply", overrides: [] });
    state = await settle(w, "applied");
    const gamma = w.sections.find((s) => s.name === "Gamma")!;
    expect(w.sections.find((s) => s.id === beta.id)?.name).toBe("Beta Prime");
    expect(w.threads.get("loose")?.sectionId).toBe(alpha.id);
    expect(w.threads.get("v1auto")?.sectionId).toBe(gamma.id);
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
  });

  it("previews from the CLI without changing anything", async () => {
    const { w } = await organized();
    const result = await w.harness.behavior.runCli(["rebuild"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      /^Preview: 3 moves, 1 new workstream, 1 rename/,
    );
    expect(w.threads.get("loose")?.sectionId).toBeNull();
  });
});
