import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { ToolFailureGuard } from "../../src/server/toolFailureGuard.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function world(disableOnLoop = true) {
  const events: Array<{
    seq: number;
    type: string;
    scope: { kind: "turn"; turnId: string };
    data: Record<string, unknown>;
  }> = [];
  let thread = makeThreadResponse({ id: "t1", status: "active" });
  let enabled = true;
  let loops = 0;
  const { bb, harness } = createFakePluginHost({
    sdk: {
      threads: {
        get: async () => thread,
        stop: async () => ({ ok: true }),
        events: {
          list: async (args: {
            types?: readonly string[];
            afterSeq?: string;
            limit?: string;
            order?: string;
          }) => {
            let rows = events.filter(
              (event) =>
                (!args.types || args.types.includes(event.type)) &&
                event.seq > Number(args.afterSeq ?? 0),
            );
            if (args.order === "desc") rows = [...rows].reverse();
            return rows.slice(0, Number(args.limit ?? 100));
          },
        },
      },
    },
  });
  const guard = new ToolFailureGuard({
    bb,
    enabled: () => enabled,
    onLoop: () => {
      loops++;
      if (disableOnLoop) enabled = false;
    },
  });
  cleanups.push(async () => {
    await guard.dispose();
    await harness.lifecycle.dispose();
  });
  let turnId = "turn1";
  const add = (type: string, data: Record<string, unknown> = {}) => {
    events.push({
      seq: events.length + 1,
      type,
      scope: { kind: "turn", turnId },
      data,
    });
  };
  const fail = (
    result = "Invalid arguments: next belongs only in continuing",
    tool = "WorkstreamsRecap",
  ) =>
    add("item/completed", {
      item: {
        type: "toolCall",
        id: `call-${events.length}`,
        tool,
        status: "failed",
        arguments: { goal: `Wording ${events.length}` },
        result,
      },
    });
  const success = () =>
    add("item/completed", {
      item: {
        type: "toolCall",
        tool: "read",
        status: "completed",
        result: "ok",
      },
    });
  const observe = () => guard.observe("t1", events.length);
  add("turn/started");
  return {
    events,
    add,
    fail,
    success,
    observe,
    guard,
    harness,
    loops: () => loops,
    disable: () => {
      enabled = false;
    },
    idle: () => {
      thread = { ...thread, status: "idle" };
    },
    nextTurn: () => {
      turnId = "turn2";
      add("turn/started");
    },
  };
}

describe("failing tool loop guard", () => {
  it("stops on the fifth same-tool same-error failure despite reworded arguments", async () => {
    const w = world();
    for (let i = 0; i < 4; i++) {
      w.fail();
      await w.observe();
    }
    expect(w.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    w.fail();
    await w.observe();
    expect(w.loops()).toBe(1);
    expect(w.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
    w.fail();
    await w.observe();
    expect(w.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
  });

  it("covers other tools and batched history after startup or reload", async () => {
    const w = world();
    for (let i = 0; i < 5; i++) w.fail("Unknown method", "mcp");
    await Promise.all([w.observe(), w.observe()]);
    expect(w.loops()).toBe(1);
    expect(w.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
  });

  it("resets after success, a different tool, or a different error", async () => {
    const w = world();
    for (let i = 0; i < 4; i++) w.fail();
    w.success();
    for (let i = 0; i < 4; i++) w.fail();
    w.fail("Different error");
    for (let i = 0; i < 4; i++) w.fail();
    w.fail(undefined, "read");
    for (let i = 0; i < 4; i++) w.fail();
    await w.observe();
    expect(w.loops()).toBe(0);
  });

  it("paginates past more than one page of output", async () => {
    const w = world();
    for (let i = 0; i < 150; i++)
      w.add("item/agentMessage/delta", { delta: "output" });
    for (let i = 0; i < 5; i++) w.fail();
    await w.observe();
    expect(w.loops()).toBe(1);
  });

  it("does not stop completed turns, idle threads, or disabled enrollment", async () => {
    for (const finish of ["completed", "idle", "disabled"]) {
      const w = world();
      for (let i = 0; i < 5; i++) w.fail();
      if (finish === "completed")
        w.add("turn/completed", { status: "completed" });
      if (finish === "idle") w.idle();
      if (finish === "disabled") w.disable();
      await w.observe();
      expect(w.loops()).toBe(0);
    }
  });

  it("never carries failures into a fresh turn", async () => {
    const w = world();
    for (let i = 0; i < 4; i++) w.fail();
    await w.observe();
    w.nextTurn();
    w.fail();
    await w.observe();
    expect(w.loops()).toBe(0);
    for (let i = 0; i < 4; i++) w.fail();
    await w.observe();
    expect(w.loops()).toBe(1);
  });

  it("retries a failed stop", async () => {
    const w = world(false);
    let attempts = 0;
    w.harness.inspection.sdk.stub("threads.stop", async () => {
      if (++attempts === 1) throw new Error("Transport failed");
      return { ok: true };
    });
    for (let i = 0; i < 5; i++) w.fail();
    await w.observe();
    expect(attempts).toBe(1);
    w.fail();
    await w.observe();
    expect(attempts).toBe(2);
  });

  it("cancels a scan invalidated before its first history read finishes", async () => {
    const w = world();
    for (let i = 0; i < 5; i++) w.fail();
    const original = w.events[0]!;
    w.harness.inspection.sdk.stub("threads.events.list", async () => {
      w.guard.forget("t1");
      return [original];
    });
    await w.observe();
    expect(w.loops()).toBe(0);
  });

  it("forgets an in-flight scan when fresh input arrives", async () => {
    const w = world();
    for (let i = 0; i < 5; i++) w.fail();
    w.harness.inspection.sdk.stub("threads.get", async () => {
      w.guard.forget("t1");
      return makeThreadResponse({ id: "t1", status: "active" });
    });
    await w.observe();
    expect(w.loops()).toBe(0);
  });
});
