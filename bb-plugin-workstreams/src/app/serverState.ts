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
  private activeMutations = 0;
  private mutationVersion = 0;
  private mutationNeedsReconcile = false;
  private pendingReorders = new Map<number, ReorderChange>();
  private pendingPrefs = new Map<number, Partial<SnoozePrefs>>();
  private latestReorderResponse = 0;
  private latestPrefsResponse = 0;

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
        if (this.activeMutations > 0) {
          this.mutationNeedsReconcile = true;
        }
        if (!this.dirty && this.activeMutations === 0) {
          this.loaded = true;
          // This read is the acknowledgement boundary. Publish its complete
          // result without overlays so failed writes roll back and server-side
          // normalization is visible; responses keep overlays only while a
          // newer write is still pending.
          this.publish({
            ...emptyState(),
            ...state,
            snoozePrefs: parseSnoozePrefs(state.snoozePrefs),
          });
          this.pendingReorders.clear();
          this.pendingPrefs.clear();
        }
      } catch {
        // Live BB data still renders; retain the last plugin snapshot.
      }
    } while (this.dirty);
  }

  private beginMutation(): number {
    this.activeMutations += 1;
    this.mutationVersion += 1;
    // A read already in flight, or a refresh requested before this write,
    // needs to be repeated after the write settles. Reads that begin during
    // the mutation mark this flag when their response is suppressed.
    // Every write needs an authoritative read before its overlay is retired.
    this.mutationNeedsReconcile = true;
    this.dirty = true;
    return this.mutationVersion;
  }

  private endMutation(): void {
    this.activeMutations -= 1;
    if (this.activeMutations === 0 && this.mutationNeedsReconcile) {
      this.mutationNeedsReconcile = false;
      void this.refresh();
    }
  }

  /** Applies manual order to every consumer before the round trip. */
  reorder = async (change: ReorderChange): Promise<void> => {
    const mutationVersion = this.beginMutation();
    this.pendingReorders.set(mutationVersion, change);
    this.publish({
      ...this.value,
      order: applyChange(this.value.order, change),
    });
    try {
      const { order } = await this.rpc.call("reorder", change);
      if (mutationVersion >= this.latestReorderResponse) {
        this.latestReorderResponse = mutationVersion;
        this.publish({
          ...this.value,
          order: this.overlayReorders(order, mutationVersion),
        });
        this.pendingReorders.delete(mutationVersion);
      }
    } catch (cause) {
      this.pendingReorders.delete(mutationVersion);
      this.mutationNeedsReconcile = true;
      throw cause;
    } finally {
      this.endMutation();
    }
  };

  private overlayReorders(
    order: ManualOrder,
    responseVersion = 0,
  ): ManualOrder {
    let next = order;
    const response = this.pendingReorders.get(responseVersion);
    for (const [version, change] of this.pendingReorders) {
      if (version === responseVersion) continue;
      const sameGroup =
        response &&
        change.kind === response.kind &&
        (change.kind === "workstreams" ||
          (response.kind === "threads" && change.groupId === response.groupId));
      if (!sameGroup || version > responseVersion)
        next = applyChange(next, change);
    }
    return next;
  }

  private overlayPrefs(prefs: SnoozePrefs): SnoozePrefs {
    let next = prefs;
    for (const patch of this.pendingPrefs.values())
      next = parseSnoozePrefs({ ...next, ...patch });
    return next;
  }

  /** `until: null` waits for activity; `wake` removes the snooze at once. */
  setSnooze = async (
    thread: { id: string; latestAttentionAt?: number },
    until: number | null | "wake",
  ): Promise<void> => {
    this.beginMutation();
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
      this.mutationNeedsReconcile = true;
      throw cause;
    } finally {
      this.endMutation();
    }
  };

  /** Saves Snooze settings for every consumer with immediate local feedback. */
  saveSnoozePrefs = async (patch: Partial<SnoozePrefs>): Promise<void> => {
    const mutationVersion = this.beginMutation();
    this.pendingPrefs.set(mutationVersion, patch);
    this.publish({
      ...this.value,
      snoozePrefs: parseSnoozePrefs({ ...this.value.snoozePrefs, ...patch }),
    });
    try {
      const { prefs } = await this.rpc.call("setSnoozePrefs", { patch });
      if (mutationVersion >= this.latestPrefsResponse) {
        this.latestPrefsResponse = mutationVersion;
        let merged = prefs;
        for (const [version, pending] of this.pendingPrefs) {
          if (version === mutationVersion) continue;
          // A whole-settings response may predate another pending field.
          // Preserve it, but never let an older edit replace this write's keys.
          const overlay = Object.fromEntries(
            Object.entries(pending).filter(
              ([key]) =>
                version > mutationVersion || !Object.hasOwn(patch, key),
            ),
          );
          merged = { ...merged, ...overlay };
        }
        this.publish({ ...this.value, snoozePrefs: parseSnoozePrefs(merged) });
      }
    } catch (cause) {
      this.pendingPrefs.delete(mutationVersion);
      this.mutationNeedsReconcile = true;
      throw cause;
    } finally {
      this.endMutation();
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
