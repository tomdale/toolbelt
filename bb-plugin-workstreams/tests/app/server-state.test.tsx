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
    proposals: [],
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
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
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
      rpc: { state: read, reorder, snooze, unsnooze },
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
    const { consumers, assertRevision } = mount({
      reorder: vi.fn(() => reordered.promise),
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
