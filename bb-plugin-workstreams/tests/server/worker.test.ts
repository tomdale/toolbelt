import { afterEach, expect, it } from "vitest";
import { fakeWorld } from "./fake-bb.ts";
import { gatewayModel } from "../../src/domain/prefs.ts";
import { WORKER_THREAD_MARKER } from "../../src/domain/worker.ts";

type World = Awaited<ReturnType<typeof fakeWorld>>;
let world: World | null = null;
afterEach(async () => {
  await world?.harness.lifecycle.dispose();
  world = null;
});

it("uses the worker path only when gatewayModel returns null", async () => {
  expect(
    gatewayModel({ kind: "gateway", model: "google/gemini-3.1-flash-lite" }),
  ).toBe("google/gemini-3.1-flash-lite");
  expect(
    gatewayModel({
      kind: "provider",
      providerId: "openai",
      model: "gpt-5.5",
      reasoningLevel: "high",
    }),
  ).toBeNull();
  world = await fakeWorld();
  const w = world;
  w.addThread("analysis", { projectId: "proj_1" });
  await w.harness.behavior.callRpc("refresh", null);
  const db = w.bb.storage.database();
  const { savePrefs } = await import("../../src/server/prefs.ts");
  savePrefs(db, {
    threads: {
      analysisModel: {
        kind: "provider",
        providerId: "openai",
        model: "gpt-5.5",
        reasoningLevel: "high",
      },
    },
  });
  await w.harness.behavior.runCli(["analyze", "analysis"]).catch(() => null);
  expect(w.workerCalls).toHaveLength(1);
  expect(w.workerCalls[0]).toMatchObject({
    title: "Workstreams worker",
    visibility: "hidden",
    permissionMode: "accept-edits",
    projectId: "proj_1",
    pluginMetadata: {
      [WORKER_THREAD_MARKER.key]: WORKER_THREAD_MARKER.value,
    },
  });
});
