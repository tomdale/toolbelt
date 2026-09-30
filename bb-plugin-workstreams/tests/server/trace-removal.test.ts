import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/server/db.ts";
import { TraceStore } from "../../src/server/trace.ts";
import type { NewTrace } from "../../src/domain/trace.ts";

it("removes source-linked trace prompts and recursive replays without deleting unrelated traces", async () => {
  const host = createFakePluginHost({ pluginId: "trace-removal" });
  try {
    const db = openDatabase(host.bb);
    const traces = new TraceStore(db);
    const base: NewTrace = {
      at: Date.now(),
      kind: "analysis",
      status: "ok",
      label: "source",
      model: "test",
      durationMs: 1,
      replayOf: null,
      provider: "test",
      thinking: "off",
      system: "",
      prompt: "private source",
      input: {},
      response: "{}",
      reasoning: null,
      stopReason: null,
      parsed: {},
      outcome: null,
      usage: null,
      error: null,
      summary: null,
    };
    const original = traces.add(base, [{ kind: "thread", ref: "deleted" }]);
    const replay = traces.add({ ...base, replayOf: original });
    const nested = traces.add({ ...base, replayOf: replay });
    const unrelated = traces.add({ ...base, prompt: "unrelated" }, [
      { kind: "thread", ref: "survivor" },
    ]);
    expect(traces.remove([], [{ kind: "thread", ref: "deleted" }])).toBe(3);
    expect(traces.get(original)).toBeNull();
    expect(traces.get(replay)).toBeNull();
    expect(traces.get(nested)).toBeNull();
    expect(traces.get(unrelated)?.prompt).toBe("unrelated");
    expect(
      db.prepare("SELECT * FROM ws_trace_link WHERE ref='deleted'").all(),
    ).toHaveLength(0);
    expect(traces.remove([original])).toBe(0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
