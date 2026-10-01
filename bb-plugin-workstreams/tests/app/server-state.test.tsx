// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  useServerState,
  type ServerState,
} from "../../src/app/useWorkstreams.ts";
import { ServerStateRealtime } from "../../src/app/serverState.ts";

const realtime = vi.hoisted(() => ({ active: new Set<object>() }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  const { useEffect, useMemo } = await import("react");
  return {
    ...sdk,
    // BB memoizes useRpc per hook. The harness normally returns the same
    // object for every hook, which would hide failures to share across slots.
    useRpc: () => {
      const rpc = sdk.useRpc();
      return useMemo(() => ({ call: rpc.call }), [rpc]);
    },
    useRealtime: (channel: string, handler: (payload: unknown) => void) => {
      sdk.useRealtime(channel, handler);
      useEffect(() => {
        if (channel !== "changed") return;
        const subscription = {};
        realtime.active.add(subscription);
        return () => {
          realtime.active.delete(subscription);
        };
      }, [channel]);
    },
  };
});

afterEach(() => {
  cleanup();
  expect(realtime.active.size).toBe(0);
});

function state(revision = 1): ServerState {
  return {
    workstreams: {},
    placements: {},
    analysis: {},
    driftDismissed: {},
    bootstrapped: true,
    lastReconciledAt: revision,
    order: { workstreams: [], threads: {} },
    snoozes: {},
    snoozePrefs: {
      default: "tomorrow",
      quick: ["1h", "tomorrow", "next-week", "activity"],
      morningHour: 9,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mount({
  read = vi.fn(async () => state()),
  reorder = vi.fn(async () => ({ order: state().order })),
  snooze = vi.fn(
    async (): Promise<{ snooze: ServerState["snoozes"][string] }> => ({
      snooze: { until: null, attentionAt: 1, at: 1 },
    }),
  ),
  unsnooze = vi.fn(async () => ({ woke: true })),
  setSnoozePrefs = vi.fn(async (input: unknown) => {
    const { patch } = input as { patch: Partial<ServerState["snoozePrefs"]> };
    return { prefs: { ...state().snoozePrefs, ...patch } };
  }),
  strict = false,
} = {}) {
  const consumers = new Map<number, ReturnType<typeof useServerState>>();
  function Consumer({ id }: { id: number }) {
    const value = useServerState();
    consumers.set(id, value);
    return (
      <output data-testid={`consumer-${id}`}>
        {value.server.lastReconciledAt}
      </output>
    );
  }
  function Suite({
    count = 3,
    bridge = true,
  }: {
    count?: number;
    bridge?: boolean;
  }) {
    const children = (
      <>
        {bridge && <ServerStateRealtime />}
        {Array.from({ length: count }, (_, id) => (
          <Consumer key={id} id={id} />
        ))}
      </>
    );
    return strict ? <StrictMode>{children}</StrictMode> : children;
  }
  const slot = renderSlot(
    { component: Suite },
    {},
    {
      rpc: { state: read, reorder, snooze, unsnooze, setSnoozePrefs },
    },
  );
  const assertRevision = async (revision: number, count = 3) => {
    await waitFor(() => {
      for (let id = 0; id < count; id++)
        expect(
          within(slot.container).getByTestId(`consumer-${id}`).textContent,
        ).toBe(String(revision));
    });
    for (let id = 1; id < count; id++)
      expect(consumers.get(id)!.server).toBe(consumers.get(0)!.server);
  };
  return { slot, read, consumers, assertRevision, Suite };
}

describe("shared server state", () => {
  it("keeps optimistic state until a deferred write is reconciled", async () => {
    const read = vi.fn(async () => state(1));
    const reordered = deferred<{ order: ServerState["order"] }>();
    const { consumers } = mount({
      read,
      reorder: vi.fn(() => reordered.promise),
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const refreshReads = [deferred<ServerState>(), deferred<ServerState>()];
    read.mockImplementation(
      () => refreshReads[read.mock.calls.length - 2]!.promise,
    );
    let pending!: Promise<void>;
    act(() => {
      pending = consumers.get(0)!.reorder({
        kind: "threads",
        groupId: "a",
        ids: ["t1"],
      });
    });
    expect(consumers.get(1)!.server.order.threads.a).toEqual(["t1"]);
    await act(async () => {
      refreshReads[0]!.resolve(state(2));
      await Promise.resolve();
    });
    expect(consumers.get(1)!.server.order.threads.a).toEqual(["t1"]);
    await act(async () => {
      refreshReads[1]!.resolve(state(3));
      await Promise.resolve();
    });
    expect(consumers.get(1)!.server.order.threads.a).toEqual(["t1"]);
    reordered.resolve({ order: { workstreams: [], threads: { a: ["t1"] } } });
    await pending;
    expect(consumers.get(1)!.server.order.threads.a).toEqual(["t1"]);
  });

  it("rolls back a rejected reorder after the recovery read", async () => {
    const failure = new Error("reorder failed");
    const write = deferred<{ order: ServerState["order"] }>();
    const recovery = deferred<ServerState>();
    const read = vi.fn(async () => state(1));
    const { consumers } = mount({ read, reorder: vi.fn(() => write.promise) });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    let pending!: Promise<void>;
    act(() => {
      pending = consumers.get(0)!.reorder({ kind: "workstreams", ids: ["a"] });
    });
    expect(consumers.get(0)!.server.order.workstreams).toEqual(["a"]);
    write.reject(failure);
    await expect(pending).rejects.toBe(failure);
    read.mockImplementation(() => recovery.promise);
    const refresh = consumers.get(0)!.refresh();
    await waitFor(() =>
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    recovery.resolve(state(2));
    await refresh;
    expect(consumers.get(0)!.server.order.workstreams).toEqual([]);
  });

  it("keeps distinct concurrent reorder groups through reverse responses", async () => {
    const firstWrite = deferred<{ order: ServerState["order"] }>();
    const secondWrite = deferred<{ order: ServerState["order"] }>();
    const writes = [firstWrite, secondWrite];
    const { consumers } = mount({
      reorder: vi.fn(() => writes.shift()!.promise),
    });
    await waitFor(() =>
      expect(consumers.get(0)!.server.bootstrapped).toBe(true),
    );
    const first = consumers
      .get(0)!
      .reorder({ kind: "threads", groupId: "a", ids: ["a1"] });
    const second = consumers
      .get(0)!
      .reorder({ kind: "threads", groupId: "b", ids: ["b1"] });
    secondWrite.resolve({ order: { workstreams: [], threads: { b: ["b1"] } } });
    firstWrite.resolve({ order: { workstreams: [], threads: { a: ["a1"] } } });
    await Promise.all([first, second]);
    expect(consumers.get(0)!.server.order.threads).toMatchObject({
      a: ["a1"],
      b: ["b1"],
    });
  });

  it("keeps the newer preference through reverse responses", async () => {
    const firstWrite = deferred<{ prefs: ServerState["snoozePrefs"] }>();
    const secondWrite = deferred<{ prefs: ServerState["snoozePrefs"] }>();
    const writes = [firstWrite, secondWrite];
    const { consumers } = mount({
      setSnoozePrefs: vi.fn(() => writes.shift()!.promise),
    });
    await waitFor(() =>
      expect(consumers.get(0)!.server.bootstrapped).toBe(true),
    );
    const first = consumers.get(0)!.saveSnoozePrefs({ morningHour: 8 });
    const second = consumers.get(0)!.saveSnoozePrefs({ morningHour: 10 });
    secondWrite.resolve({ prefs: { ...state().snoozePrefs, morningHour: 10 } });
    firstWrite.resolve({ prefs: { ...state().snoozePrefs, morningHour: 8 } });
    await Promise.all([first, second]);
    expect(consumers.get(0)!.server.snoozePrefs.morningHour).toBe(10);
  });

  it("re-reads a realtime change consumed during an active mutation", async () => {
    const firstRead = deferred<ServerState>();
    const secondRead = deferred<ServerState>();
    const write = deferred<{ order: ServerState["order"] }>();
    const read = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(state(1)))
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => secondRead.promise);
    const { slot, consumers } = mount({
      read,
      reorder: vi.fn(() => write.promise),
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const mutation = consumers.get(0)!.reorder({
      kind: "workstreams",
      ids: ["a"],
    });
    await slot.behavior.emitRealtime("changed", {});
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    firstRead.resolve({ ...state(2), driftDismissed: { t: "server-change" } });
    await Promise.resolve();
    expect(consumers.get(0)!.server.driftDismissed).toEqual({});
    write.resolve({ order: { workstreams: ["a"], threads: {} } });
    await mutation;
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    secondRead.resolve({ ...state(3), driftDismissed: { t: "server-change" } });
    await waitFor(() =>
      expect(consumers.get(0)!.server.lastReconciledAt).toBe(3),
    );
    expect(consumers.get(0)!.server.driftDismissed).toEqual({
      t: "server-change",
    });
  });

  it("rolls back rejected preferences and shows authoritative normalization", async () => {
    const failure = new Error("preferences failed");
    const write = deferred<{ prefs: ServerState["snoozePrefs"] }>();
    const recovery = deferred<ServerState>();
    const read = vi
      .fn()
      .mockResolvedValueOnce(state(1))
      .mockImplementationOnce(() => recovery.promise)
      .mockResolvedValueOnce({
        ...state(2),
        snoozePrefs: { ...state().snoozePrefs, morningHour: 6 },
      });
    const { consumers } = mount({
      read,
      setSnoozePrefs: vi.fn(() => write.promise),
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    let pending!: Promise<void>;
    act(() => {
      pending = consumers.get(0)!.saveSnoozePrefs({ morningHour: 22 });
    });
    // Preference parsing clamps invalid hours before the RPC starts.
    expect(consumers.get(0)!.server.snoozePrefs.morningHour).toBe(12);
    write.reject(failure);
    await expect(pending).rejects.toBe(failure);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    recovery.resolve({
      ...state(2),
      snoozePrefs: { ...state().snoozePrefs, morningHour: 6 },
    });
    await waitFor(() =>
      expect(consumers.get(0)!.server.snoozePrefs.morningHour).toBe(6),
    );
  });

  it("stages same-group reverse responses for every consumer and converges authoritatively", async () => {
    const firstWrite = deferred<{ order: ServerState["order"] }>();
    const secondWrite = deferred<{ order: ServerState["order"] }>();
    const recovery = deferred<ServerState>();
    let committed = state(1);
    const writes = [firstWrite, secondWrite];
    const read = vi.fn(async () => committed);
    const { consumers } = mount({
      read,
      reorder: vi.fn(() => writes.shift()!.promise),
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = consumers
        .get(0)!
        .reorder({ kind: "threads", groupId: "a", ids: ["a1"] });
      second = consumers
        .get(1)!
        .reorder({ kind: "threads", groupId: "a", ids: ["a2"] });
    });
    const newer = { workstreams: [], threads: { a: ["a2"] } };
    secondWrite.resolve({ order: newer });
    await second;
    for (const value of consumers.values())
      expect(value.server.order.threads.a).toEqual(["a2"]);
    const older = { workstreams: [], threads: { a: ["a1"] } };
    committed = { ...state(3), order: newer };
    firstWrite.resolve({ order: older });
    await first;
    for (const value of consumers.values())
      expect(value.server.order.threads.a).toEqual(["a2"]);
    read.mockImplementationOnce(() => recovery.promise);
    const refresh = consumers.get(0)!.refresh();
    await waitFor(() =>
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    recovery.resolve(committed);
    await refresh;
    for (const value of consumers.values())
      expect(value.server.order.threads.a).toEqual(["a2"]);
  });

  it("keeps a successful overlapping write after another write fails", async () => {
    const failed = deferred<{ order: ServerState["order"] }>();
    const succeeded = deferred<{ order: ServerState["order"] }>();
    const recovery = deferred<ServerState>();
    let calls = 0;
    let committed = state(1);
    const read = vi.fn(async () => committed);
    const { consumers } = mount({
      read,
      reorder: vi.fn(() => (++calls === 1 ? failed : succeeded).promise),
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = consumers
        .get(0)!
        .reorder({ kind: "threads", groupId: "a", ids: ["a1"] });
      second = consumers
        .get(1)!
        .reorder({ kind: "threads", groupId: "b", ids: ["b1"] });
    });
    failed.reject(new Error("first failed"));
    await expect(first).rejects.toThrow("first failed");
    for (const value of consumers.values())
      expect(value.server.order.threads.b).toEqual(["b1"]);
    const committedOrder = { workstreams: [], threads: { b: ["b1"] } };
    succeeded.resolve({ order: committedOrder });
    await second;
    committed = { ...state(4), order: committedOrder };
    read.mockImplementationOnce(() => recovery.promise);
    const refresh = consumers.get(0)!.refresh();
    await waitFor(() =>
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    recovery.resolve(committed);
    await refresh;
    for (const value of consumers.values())
      expect(value.server.order.threads).toEqual({ b: ["b1"] });
  });

  it("publishes successful server normalization to every consumer", async () => {
    const response = deferred<{ order: ServerState["order"] }>();
    const recovery = deferred<ServerState>();
    const normalized = { workstreams: ["server-order"], threads: {} };
    const read = vi.fn(async () => state(1));
    const { consumers } = mount({
      read,
      reorder: vi.fn(() => response.promise),
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    let pending!: Promise<void>;
    act(() => {
      pending = consumers
        .get(0)!
        .reorder({ kind: "workstreams", ids: ["requested"] });
    });
    response.resolve({ order: normalized });
    await pending;
    for (const value of consumers.values())
      expect(value.server.order).toEqual(normalized);
    read.mockImplementationOnce(() => recovery.promise);
    const refresh = consumers.get(0)!.refresh();
    await waitFor(() =>
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    recovery.resolve({ ...state(5), order: normalized });
    await refresh;
    for (const value of consumers.values())
      expect(value.server.order).toEqual(normalized);
  });

  it("publishes successful preference normalization to every consumer", async () => {
    const response = deferred<{ prefs: ServerState["snoozePrefs"] }>();
    const recovery = deferred<ServerState>();
    const normalized = { ...state().snoozePrefs, morningHour: 7 };
    const read = vi.fn(async () => state(1));
    const { consumers } = mount({
      read,
      setSnoozePrefs: vi.fn(() => response.promise),
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    let pending!: Promise<void>;
    act(() => {
      pending = consumers.get(0)!.saveSnoozePrefs({ morningHour: 9 });
    });
    response.resolve({ prefs: normalized });
    await pending;
    for (const value of consumers.values())
      expect(value.server.snoozePrefs.morningHour).toBe(7);
    read.mockImplementationOnce(() => recovery.promise);
    const refresh = consumers.get(0)!.refresh();
    await waitFor(() =>
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    recovery.resolve({ ...state(6), snoozePrefs: normalized });
    await refresh;
    for (const value of consumers.values())
      expect(value.server.snoozePrefs.morningHour).toBe(7);
  });

  it("preserves an older pending preference on an independent field", async () => {
    const older = deferred<{ prefs: ServerState["snoozePrefs"] }>();
    const newer = deferred<{ prefs: ServerState["snoozePrefs"] }>();
    let committed = state();
    let writes = 0;
    const { consumers, assertRevision } = mount({
      read: vi.fn(async () => committed),
      setSnoozePrefs: vi.fn(() => (++writes === 1 ? older : newer).promise),
    });
    await assertRevision(1);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = consumers.get(0)!.saveSnoozePrefs({ default: "activity" });
      second = consumers.get(1)!.saveSnoozePrefs({ morningHour: 7 });
    });
    await act(async () => {
      newer.resolve({ prefs: { ...state().snoozePrefs, morningHour: 7 } });
      await second;
    });
    for (const value of consumers.values()) {
      expect(value.server.snoozePrefs.default).toBe("activity");
      expect(value.server.snoozePrefs.morningHour).toBe(7);
    }
    committed = {
      ...state(2),
      snoozePrefs: {
        ...state().snoozePrefs,
        default: "activity",
        morningHour: 7,
      },
    };
    await act(async () => {
      older.resolve({ prefs: committed.snoozePrefs });
      await first;
    });
    await waitFor(() => {
      for (const value of consumers.values())
        expect(value.server.snoozePrefs).toEqual(committed.snoozePrefs);
    });
  });

  it("registers one app-wide realtime bridge", async () => {
    const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
    expect(
      app.appOverlays.filter((entry) => entry.id === "server-state"),
    ).toEqual([{ id: "server-state", component: ServerStateRealtime }]);
  });

  it("shares initial loading, a snapshot and one changed subscription across consumers", async () => {
    const initial = deferred<ServerState>();
    const read = vi.fn(() => initial.promise);
    const { slot, consumers, assertRevision, Suite } = mount({ read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(realtime.active.size).toBe(1);
    for (const value of consumers.values()) {
      expect(value.server.bootstrapped).toBe(false);
      expect(value.rpc).toBe(consumers.get(0)!.rpc);
      expect(value.refresh).toBe(consumers.get(0)!.refresh);
    }
    slot.lifecycle.rerender(<Suite count={6} />);
    await act(async () => initial.resolve(state(1)));
    await assertRevision(1, 6);
    expect(read).toHaveBeenCalledTimes(1);
    slot.lifecycle.rerender(<Suite count={7} />);
    await assertRevision(1, 7);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockImplementation(async () => state(2));
    await slot.behavior.emitRealtime("changed", {});
    await assertRevision(2, 7);
    expect(read).toHaveBeenCalledTimes(2);
    expect(realtime.active.size).toBe(1);
  });

  it("coalesces in-flight change bursts and explicit refreshes into a fresh read", async () => {
    const requests = [deferred<ServerState>(), deferred<ServerState>()];
    const read = vi.fn(() => requests[read.mock.calls.length - 1]!.promise);
    const { slot, consumers, assertRevision } = mount({ read });
    await slot.behavior.emitRealtime("changed", {});
    await slot.behavior.emitRealtime("changed", {});
    let refresh!: Promise<void>;
    act(() => {
      refresh = consumers.get(0)!.refresh();
      expect(consumers.get(1)!.refresh()).toBe(refresh);
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => requests[0]!.resolve(state(1)));
    expect(read).toHaveBeenCalledTimes(2);
    expect(consumers.get(0)!.server.lastReconciledAt).toBeNull();
    await act(async () => {
      requests[1]!.resolve(state(2));
      await refresh;
    });
    await assertRevision(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares optimistic order, snooze and wake updates", async () => {
    const reordered = deferred<{ order: ServerState["order"] }>();
    const snoozed = deferred<{ snooze: ServerState["snoozes"][string] }>();
    const woken = deferred<{ woke: boolean }>();
    let committedOrder = state().order;
    const read = vi.fn(async () => ({ ...state(), order: committedOrder }));
    const { consumers, assertRevision } = mount({
      read,
      reorder: vi.fn(async () => {
        const result = await reordered.promise;
        committedOrder = result.order;
        return result;
      }),
      snooze: vi.fn(() => snoozed.promise),
      unsnooze: vi.fn(() => woken.promise),
    });
    await assertRevision(1);
    let pending!: Promise<void>;
    act(() => {
      pending = consumers
        .get(0)!
        .reorder({ kind: "threads", groupId: "a", ids: ["t1"] });
    });
    for (const value of consumers.values())
      expect(value.server.order.threads.a).toEqual(["t1"]);
    const order = { workstreams: ["a"], threads: { a: ["t1"] } };
    await act(async () => {
      reordered.resolve({ order });
      await pending;
    });
    for (const value of consumers.values())
      expect(value.server.order).toEqual(order);
    act(() => {
      pending = consumers
        .get(1)!
        .setSnooze({ id: "t1", latestAttentionAt: 42 }, null);
    });
    for (const value of consumers.values())
      expect(value.server.snoozes.t1).toMatchObject({
        until: null,
        attentionAt: 42,
      });
    await act(async () => {
      snoozed.resolve({ snooze: { until: null, attentionAt: 42, at: 1 } });
      await pending;
    });
    act(() => {
      pending = consumers.get(2)!.setSnooze({ id: "t1" }, "wake");
    });
    for (const value of consumers.values())
      expect(value.server.snoozes.t1).toBeUndefined();
    await act(async () => {
      woken.resolve({ woke: true });
      await pending;
    });
  });

  it.each(["reorder", "snooze", "unsnooze"] as const)(
    "refreshes all consumers and preserves the original %s failure",
    async (method) => {
      const cause = new Error("save failed");
      const read = vi.fn(async () => state(1));
      const fail = vi.fn(async () => {
        throw cause;
      });
      const { consumers, assertRevision } = mount({ read, [method]: fail });
      await assertRevision(1);
      read.mockImplementation(async () => state(2));
      await act(async () => {
        const value = consumers.get(0)!;
        const result =
          method === "reorder"
            ? value.reorder({ kind: "workstreams", ids: ["a"] })
            : value.setSnooze(
                { id: "t1" },
                method === "snooze" ? 1000 : "wake",
              );
        await expect(result).rejects.toBe(cause);
      });
      await assertRevision(2);
      for (const value of consumers.values()) {
        expect(value.server.order).toEqual(state().order);
        expect(value.server.snoozes).toEqual({});
      }
      expect(read).toHaveBeenCalledTimes(2);
    },
  );

  it("silently retains the snapshot when a refresh or recovery read fails", async () => {
    const cause = new Error("mutation failed");
    const { read, consumers, assertRevision } = mount({
      reorder: vi.fn(async () => {
        throw cause;
      }),
    });
    await assertRevision(1);
    const snapshot = consumers.get(0)!.server;
    read.mockRejectedValue(new Error("offline"));
    await act(async () => {
      await expect(consumers.get(1)!.refresh()).resolves.toBeUndefined();
    });
    expect(consumers.get(0)!.server).toBe(snapshot);
    await act(async () => {
      await expect(
        consumers.get(0)!.reorder({ kind: "workstreams", ids: ["a"] }),
      ).rejects.toBe(cause);
    });
    for (const value of consumers.values())
      expect(value.server.order.workstreams).toEqual(["a"]);
  });

  it("retries a failed initial load when another consumer mounts", async () => {
    const read = vi.fn(async () => {
      throw new Error("offline");
    }) as ReturnType<typeof vi.fn<() => Promise<ServerState>>>;
    const { slot, consumers, assertRevision, Suite } = mount({ read });
    await act(async () => {});
    expect(consumers.get(0)!.server.bootstrapped).toBe(false);
    read.mockImplementation(async () => state(2));
    slot.lifecycle.rerender(<Suite count={4} />);
    await assertRevision(2, 4);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("isolates independent clients and realtime events", async () => {
    const first = mount({ read: vi.fn(async () => state(1)) });
    const second = mount({ read: vi.fn(async () => state(10)) });
    await first.assertRevision(1);
    await second.assertRevision(10);
    expect(first.consumers.get(0)!.rpc).not.toBe(second.consumers.get(0)!.rpc);
    expect(first.consumers.get(0)!.server).not.toBe(
      second.consumers.get(0)!.server,
    );
    first.read.mockImplementation(async () => state(2));
    await first.slot.behavior.emitRealtime("changed", {});
    await first.assertRevision(2);
    await second.assertRevision(10);
    expect(second.read).toHaveBeenCalledTimes(1);
  });

  it("isolates empty snapshots before independent clients load", async () => {
    const request = deferred<ServerState>();
    const first = mount({ read: vi.fn(() => request.promise) });
    const second = mount({ read: vi.fn(() => request.promise) });
    const left = first.consumers.get(0)!.server;
    const right = second.consumers.get(0)!.server;
    expect(left).not.toBe(right);
    expect(left.order).not.toBe(right.order);
    expect(left.snoozes).not.toBe(right.snoozes);
    await act(async () => request.resolve(state(1)));
  });

  it("releases listeners and realtime on teardown and revalidates on remount", async () => {
    const request = deferred<ServerState>();
    const read = vi.fn(() => request.promise);
    const { slot, consumers, assertRevision, Suite } = mount({ read });
    slot.lifecycle.rerender(<Suite count={0} bridge={false} />);
    expect(realtime.active.size).toBe(0);
    const before = consumers.get(0)!.server;
    await slot.behavior.emitRealtime("changed", {});
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve(state(1)));
    expect(consumers.get(0)!.server).toBe(before);
    read.mockImplementation(async () => state(2));
    slot.lifecycle.rerender(<Suite />);
    await assertRevision(2);
    expect(realtime.active.size).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares loading and disposes subscriptions during Strict Mode effect replay", async () => {
    const { read, assertRevision } = mount({ strict: true });
    await assertRevision(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(realtime.active.size).toBe(1);
  });
});
