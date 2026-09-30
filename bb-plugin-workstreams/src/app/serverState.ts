import { useRealtime, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { useSyncExternalStore } from "react";
import type { RpcContract } from "../server/contract.ts";
import type { ManualOrder } from "../domain/order.ts";
import {
  DEFAULT_SNOOZE_PREFS,
  parseSnoozePrefs,
  type SnoozePrefs,
} from "../domain/snooze.ts";
import type { ServerState, ReorderChange } from "./useWorkstreams.ts";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

function emptyState(): ServerState {
  return {
    workstreams: {},
    placements: {},
    analysis: {},
    proposals: [],
    driftDismissed: {},
    bootstrapped: false,
    lastReconciledAt: null,
    order: { workstreams: [], threads: {} },
    snoozes: {},
    snoozePrefs: DEFAULT_SNOOZE_PREFS,
  };
}

class ServerStore {
  private value = emptyState();
  private listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  private dirty = false;
  private loaded = false;

  constructor(readonly rpc: Rpc) {}

  snapshot = (): ServerState => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    // A remount reconciles changes missed while nobody was listening. Joining
    // an initial fetch must not invalidate it or queue a fetch per consumer.
    if ((this.listeners.size === 1 || !this.loaded) && !this.pending)
      void this.refresh();
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(value: ServerState): void {
    this.value = value;
    for (const listener of this.listeners) listener();
  }

  refresh = (): Promise<void> => {
    this.dirty = true;
    if (!this.pending)
      this.pending = this.fetch().finally(() => {
        this.pending = null;
      });
    return this.pending;
  };

  private async fetch(): Promise<void> {
    do {
      this.dirty = false;
      try {
        const state = await this.rpc.call("state", null);
        // A change arriving during the request needs a fresh read. Publishing
        // that older response would briefly undo a shared optimistic update.
        if (!this.dirty) {
          this.loaded = true;
          this.publish({
            ...emptyState(),
            ...state,
            snoozePrefs: parseSnoozePrefs(state.snoozePrefs),
          });
        }
      } catch {
        // Live BB data still renders; retain the last plugin snapshot.
      }
    } while (this.dirty);
  }

  /** Applies manual order to every consumer before the round trip. */
  reorder = async (change: ReorderChange): Promise<void> => {
    this.publish({
      ...this.value,
      order: applyChange(this.value.order, change),
    });
    try {
      const { order } = await this.rpc.call("reorder", change);
      this.publish({ ...this.value, order });
    } catch (cause) {
      await this.refresh();
      throw cause;
    }
  };

  /** `until: null` waits for activity; `wake` removes the snooze at once. */
  setSnooze = async (
    thread: { id: string; latestAttentionAt?: number },
    until: number | null | "wake",
  ): Promise<void> => {
    const snoozes = { ...this.value.snoozes };
    if (until === "wake") delete snoozes[thread.id];
    else
      snoozes[thread.id] = {
        until,
        attentionAt: thread.latestAttentionAt ?? Date.now(),
        at: Date.now(),
      };
    this.publish({ ...this.value, snoozes });
    try {
      if (until === "wake")
        await this.rpc.call("unsnooze", { threadId: thread.id });
      else await this.rpc.call("snooze", { threadId: thread.id, until });
    } catch (cause) {
      await this.refresh();
      throw cause;
    }
  };

  /** Saves Snooze settings for every consumer with immediate local feedback. */
  saveSnoozePrefs = async (patch: Partial<SnoozePrefs>): Promise<void> => {
    this.publish({
      ...this.value,
      snoozePrefs: parseSnoozePrefs({ ...this.value.snoozePrefs, ...patch }),
    });
    try {
      const { prefs } = await this.rpc.call("setSnoozePrefs", { patch });
      this.publish({ ...this.value, snoozePrefs: parseSnoozePrefs(prefs) });
    } catch (cause) {
      await this.refresh();
      throw cause;
    }
  };
}

function applyChange(order: ManualOrder, change: ReorderChange): ManualOrder {
  if (change.kind === "workstreams")
    return { ...order, workstreams: change.ids };
  return {
    ...order,
    threads: { ...order.threads, [change.groupId]: change.ids },
  };
}

const clients = new WeakMap<object, Rpc>();
const stores = new WeakMap<Rpc, ServerStore>();

function useStore(): ServerStore {
  const candidate = useRpc<RpcContract>();
  const sdk = useSdk();
  // useRpc memoizes per hook, while useSdk is shared across this plugin's
  // slots in one client. Select one RPC client within that stable scope.
  let rpc = clients.get(sdk);
  if (!rpc) {
    rpc = candidate;
    clients.set(sdk, rpc);
  }
  let store = stores.get(rpc);
  if (!store) {
    store = new ServerStore(rpc);
    stores.set(rpc, store);
  }
  return store;
}

/** One snapshot and shared optimistic actions for this plugin's RPC client. */
export function useSharedServerState() {
  const store = useStore();
  const server = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  return {
    rpc: store.rpc,
    server,
    refresh: store.refresh,
    reorder: store.reorder,
    setSnooze: store.setSnooze,
    saveSnoozePrefs: store.saveSnoozePrefs,
  };
}

/** BB mounts this once per app window and disposes its subscription on unload. */
export function ServerStateRealtime(): null {
  const { refresh } = useSharedServerState();
  useRealtime("changed", refresh);
  return null;
}
