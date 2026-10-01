import { useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../server/contract.ts";
import {
  mergePrefs,
  parsePrefs,
  type Prefs,
  type PrefsPatch,
} from "../domain/prefs.ts";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

/**
 * One copy of the preferences per plugin client, shared by every component
 * that reads them (inspect buttons render one per row), so the first reader
 * loads them once and the rest subscribe.
 */
class PrefsStore {
  private value: Prefs | null = null;
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;

  constructor(private readonly rpc: Rpc) {}

  snapshot = () => this.value;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set = (next: Prefs | null) => {
    this.value = next;
    for (const listener of this.listeners) listener();
  };

  load = () => {
    this.loading ??= this.rpc
      .call("prefs", null)
      .then(({ prefs }) => this.set(parsePrefs(prefs)))
      .catch(() => {
        // A later reader retries.
        this.loading = null;
      });
  };

  save = async (patch: PrefsPatch) => {
    const before = this.value;
    if (before) this.set(mergePrefs(before, patch));
    try {
      const { prefs } = await this.rpc.call("setPrefs", { patch });
      this.set(parsePrefs(prefs));
    } catch (error) {
      this.set(before);
      throw error;
    }
  };
}

const clients = new WeakMap<object, Rpc>();
const stores = new WeakMap<Rpc, PrefsStore>();

function useStore(): PrefsStore {
  const candidate = useRpc<RpcContract>();
  const sdk = useSdk();
  // useRpc memoizes per hook, while useSdk is shared across this plugin's
  // slots in one client; key the store on one RPC client within that scope.
  let rpc = clients.get(sdk);
  if (!rpc) {
    rpc = candidate;
    clients.set(sdk, rpc);
  }
  let store = stores.get(rpc);
  if (!store) {
    store = new PrefsStore(rpc);
    stores.set(rpc, store);
  }
  return store;
}

/**
 * Workstreams' preferences, kept current across windows by the `prefs`
 * realtime broadcast. Null until the first load. `save` applies the patch
 * locally first so controls respond immediately, and reverts if the server
 * rejects it.
 */
export function usePrefs() {
  const store = useStore();
  const prefs = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  useEffect(store.load, [store]);
  useRealtime("prefs", (payload) =>
    store.set(parsePrefs((payload as { prefs?: unknown })?.prefs)),
  );
  return { prefs, save: store.save };
}
