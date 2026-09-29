import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { callFromEvent, resetFromEvent, snapshotForThread } from "./snapshot.ts";

test("only successful completed Pi todo events replay", () => {
  const item = (status: string, result: unknown, args: unknown, tool = "todo") => ({
    seq: 1, type: "item/completed", data: { item: { type: "toolCall", status, result, tool, arguments: args } },
  });
  assert.deepEqual(callFromEvent(item("completed", "Created #1", { action: "create", subject: "OK" })), { action: "create", subject: "OK" });
  assert.equal(callFromEvent(item("failed", "Created #1", { action: "create", subject: "No" })), null);
  assert.equal(callFromEvent(item("completed", "Error: failed", { action: "create", subject: "No" })), null);
  assert.equal(callFromEvent(item("completed", "Created", { action: "create" }, "bb_todo")), null);
});

test("paginates in sequence and keeps separate thread snapshots via public SDK", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  const events = Array.from({ length: 501 }, (_, i) => ({
    id: `ev${i}`, seq: i + 1, type: "item/completed" as const, threadId: "thread-a", scope: { kind: "thread" as const }, createdAt: i,
    data: { item: { type: "toolCall", tool: "todo", status: "completed", id: `c${i}`, arguments: i === 0 ? { action: "batch", operations: [{ action: "create", subject: "Start" }, { action: "create", subject: "Next" }] } : { action: "create", subject: `Task ${i}` }, result: "Created" } },
  }));
  harness.sdk.stub("threads.events.list", async (args: { threadId: string; afterSeq?: string; limit?: string }) => {
    const limit = Math.min(Number(args.limit ?? 100), 100);
    return args.threadId === "thread-a" ? events.filter(e => e.seq > Number(args.afterSeq ?? 0)).slice(0, limit) : [];
  });
  await plugin(bb);
  try {
    const a = await harness.behavior.callRpc("snapshot", { threadId: "thread-a" });
    assert.equal(a.tasks.length, 502);
    assert.equal(a.nextId, 503);
    assert.deepEqual((await harness.behavior.callRpc("snapshot", { threadId: "thread-b" })).tasks, []);
    assert.ok(harness.inspection.sdk.callsTo("threads.events.list").length >= 6);
    assert.equal((await snapshotForThread(bb, "thread-b")).tasks.length, 0);
    assert.deepEqual([...harness.registrations.agentTools.keys()], []);
  } finally { await harness.lifecycle.dispose(); }
});

test("replays durable reset boundaries in order using Pi's authoritative nextId", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  const todo = (seq: number, subject: string) => ({
    seq, type: "item/completed", data: { item: { type: "toolCall", tool: "todo", status: "completed", arguments: { action: "create", subject }, result: "Created" } },
  });
  const reset = (seq: number, nextId: number) => ({
    seq, type: "system/plugin-todo-reset", data: { pluginId: "pi-todo", requestId: "ec48d3bd-e9c1-4271-99cf-9e27aef416ab", status: "completed", nextId },
  });
  const pending = (seq: number) => ({ seq, type: "system/plugin-todo-reset", data: { pluginId: "pi-todo", requestId: "ec48d3bd-e9c1-4271-99cf-9e27aef416ab", status: "pending" } });
  const events = [todo(1, "Old"), pending(2), reset(3, 19), todo(4, "New"), pending(5), reset(6, 20), todo(7, "Newest")];
  harness.sdk.stub("threads.events.list", async (args: { afterSeq?: string }) => events.filter(event => event.seq > Number(args.afterSeq ?? 0)));
  try {
    assert.deepEqual(await snapshotForThread(bb, "thread-a"), {
      tasks: [{ id: 20, subject: "Newest", status: "pending" }], nextId: 21,
      pendingClear: null, completedClear: "ec48d3bd-e9c1-4271-99cf-9e27aef416ab",
    });
    assert.deepEqual(resetFromEvent(reset(3, 19)), { status: "completed", requestId: "ec48d3bd-e9c1-4271-99cf-9e27aef416ab", nextId: 19 });
    assert.deepEqual(resetFromEvent(pending(2)), { status: "pending", requestId: "ec48d3bd-e9c1-4271-99cf-9e27aef416ab" });
    assert.equal(resetFromEvent({ ...reset(2, 19), type: "item/completed" }), null);
    assert.equal(resetFromEvent({ ...reset(2, 19), data: { ...reset(2, 19).data, pluginId: "other" } }), null);
    assert.equal(resetFromEvent(reset(2, Number.MAX_SAFE_INTEGER + 1)), null);
    assert.equal(resetFromEvent({ ...reset(2, 19), data: { ...reset(2, 19).data, requestId: "not-a-uuid" } }), null);
    assert.equal(resetFromEvent({ ...reset(2, 19), data: { ...reset(2, 19).data, extra: true } }), null);
    assert.equal(resetFromEvent({ ...pending(2), data: { ...pending(2).data, nextId: 19 } }), null);
  } finally { await harness.lifecycle.dispose(); }
});

test("a pending clear masks old tasks across reload and only matching completion resets replay", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  const event = (seq: number, type: string, data: unknown) => ({ seq, type, data });
  const requestId = "ec48d3bd-e9c1-4271-99cf-9e27aef416ab";
  const item = (subject: string) => ({ item: { type: "toolCall", tool: "todo", status: "completed", arguments: { action: "create", subject }, result: "Created" } });
  const events = [event(1, "item/completed", item("Old")), event(2, "system/plugin-todo-reset", { pluginId: "pi-todo", requestId, status: "pending" })];
  harness.sdk.stub("threads.events.list", async (args: { afterSeq?: string }) => events.filter(e => e.seq > Number(args.afterSeq ?? 0)));
  try {
    assert.deepEqual(await snapshotForThread(bb, "thread-a"), { tasks: [], nextId: 2, pendingClear: requestId, completedClear: null });
    events.push(event(3, "item/completed", item("Unconfirmed")));
    events.push(event(4, "system/plugin-todo-reset", { pluginId: "pi-todo", requestId: "49effbf7-1cd1-49b1-b86f-53b3ebeb64f9", status: "completed", nextId: 10 }));
    assert.deepEqual((await snapshotForThread(bb, "thread-a")).tasks, []);
    assert.equal((await snapshotForThread(bb, "thread-a")).pendingClear, requestId);
    events.push(event(5, "system/plugin-todo-reset", { pluginId: "pi-todo", requestId, status: "completed", nextId: 19 }));
    events.push(event(6, "item/completed", item("New")));
    assert.deepEqual(await snapshotForThread(bb, "thread-a"), {
      tasks: [{ id: 19, subject: "New", status: "pending" }], nextId: 20, pendingClear: null, completedClear: requestId,
    });
  } finally { await harness.lifecycle.dispose(); }
});

test("clear calls only the scoped Pi reset action and returns its durable boundary", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  harness.sdk.stub("threads.experimental_providerAction", async () => ({ nextId: 19, boundarySequence: 42 }));
  await plugin(bb);
  try {
    const requestId = "ec48d3bd-e9c1-4271-99cf-9e27aef416ab";
    assert.deepEqual(await harness.behavior.callRpc("clear", { threadId: "thread-a", requestId }), { nextId: 19, boundarySequence: 42 });
    const calls = harness.inspection.sdk.callsTo("threads.experimental_providerAction");
    assert.equal(calls.length, 1);
    const request = calls[0]![0] as { threadId: string; action: string; requestId: string };
    assert.equal(request.threadId, "thread-a");
    assert.equal(request.action, "pi-todo.reset");
    assert.equal(request.requestId, requestId);
    assert.equal(harness.inspection.sdk.callsTo("threads.events.list").length, 0);
  } finally { await harness.lifecycle.dispose(); }
});

test("clear propagates provider errors without writing synthetic state", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  harness.sdk.stub("threads.experimental_providerAction", async () => { throw new Error("Pi Todo reset unavailable"); });
  await plugin(bb);
  try {
    const requestId = "ec48d3bd-e9c1-4271-99cf-9e27aef416ab";
    await assert.rejects(harness.behavior.callRpc("clear", { threadId: "thread-a", requestId }), /Pi Todo reset unavailable/);
    assert.equal(harness.inspection.sdk.callsTo("threads.events.list").length, 0);
  } finally { await harness.lifecycle.dispose(); }
});

test("retry forwards the same UUID and reads pending only from the BB timeline", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  const requestId = "ec48d3bd-e9c1-4271-99cf-9e27aef416ab";
  const events = [{
    seq: 1, type: "item/completed", data: { item: { type: "toolCall", tool: "todo", status: "completed", arguments: { action: "create", subject: "Old" }, result: "Created" } },
  }];
  harness.sdk.stub("threads.events.list", async (args: { afterSeq?: string }) => events.filter(event => event.seq > Number(args.afterSeq ?? 0)));
  let attempts = 0;
  harness.sdk.stub("threads.experimental_providerAction", async () => {
    if (++attempts === 1) {
      events.push({ seq: 2, type: "system/plugin-todo-reset", data: { pluginId: "pi-todo", requestId, status: "pending" } });
      throw new Error("boundary append interrupted");
    }
    return { nextId: 19, boundarySequence: 42 };
  });
  await plugin(bb);
  try {
    await assert.rejects(harness.behavior.callRpc("clear", { threadId: "thread-a", requestId }), /boundary append interrupted/);
    assert.deepEqual(await harness.behavior.callRpc("snapshot", { threadId: "thread-a" }), {
      tasks: [], nextId: 2, pendingClear: requestId, completedClear: null,
    });
    assert.deepEqual(await harness.behavior.callRpc("clear", { threadId: "thread-a", requestId }), { nextId: 19, boundarySequence: 42 });
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.experimental_providerAction").map(call => call[0]), [
      { threadId: "thread-a", action: "pi-todo.reset", requestId },
      { threadId: "thread-a", action: "pi-todo.reset", requestId },
    ]);
  } finally { await harness.lifecycle.dispose(); }
});

test("timeline errors propagate rather than displaying a misleading partial list", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "todo" });
  harness.sdk.stub("threads.events.list", async () => { throw new Error("timeline unavailable"); });
  await plugin(bb);
  try { await assert.rejects(harness.behavior.callRpc("snapshot", { threadId: "thread-a" }), /timeline unavailable/); }
  finally { await harness.lifecycle.dispose(); }
});
