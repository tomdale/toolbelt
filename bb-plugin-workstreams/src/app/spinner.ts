/**
 * The working indicator's style, shared by every mark in the app. Each RPC
 * client gets one store, so dozens of rows cost one fetch; the server pushes
 * changes on the `spinner` realtime channel. A change made in settings shows
 * at once and is saved after a short pause, so dragging through a color
 * picker sends one write rather than dozens.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  DEFAULT_SPINNER,
  parseSpinner,
  sameSpinner,
  type SpinnerStyle,
} from "../domain/spinner.ts";
import type { RpcContract } from "../server/contract.ts";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

const SAVE_DELAY_MS = 250;

type Store = {
  value: SpinnerStyle;
  /** The last style the server confirmed; a failed save returns to it. */
  saved: SpinnerStyle;
  loading: boolean;
  loaded: boolean;
  /** A local change is waiting to be saved or is being saved. */
  changing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  listeners: Set<() => void>;
};

const stores = new WeakMap<object, Store>();

function storeFor(rpc: Rpc): Store {
  let store = stores.get(rpc);
  if (!store) {
    store = {
      value: DEFAULT_SPINNER,
      saved: DEFAULT_SPINNER,
      loading: false,
      loaded: false,
      changing: false,
      timer: null,
      listeners: new Set(),
    };
    stores.set(rpc, store);
  }
  return store;
}

function publish(store: Store, value: SpinnerStyle): void {
  if (sameSpinner(store.value, value)) return;
  store.value = value;
  for (const listener of store.listeners) listener();
}

/** The chosen style; BB's own until the stored choice loads. */
export function useSpinner(): SpinnerStyle {
  const rpc = useRpc<RpcContract>();
  const store = storeFor(rpc);
  const subscribe = useCallback(
    (listener: () => void) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    [store],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => store.value,
    () => store.value,
  );
  useEffect(() => {
    if (store.loaded || store.loading) return;
    store.loading = true;
    rpc.call("spinner", null).then(
      ({ spinner }) => {
        store.loaded = true;
        store.loading = false;
        store.saved = parseSpinner(spinner);
        // A pick made while the stored style loaded wins over it.
        if (!store.changing) publish(store, store.saved);
      },
      () => {
        // Keep BB's own style; the next mount tries again.
        store.loading = false;
      },
    );
  }, [rpc, store]);
  useRealtime("spinner", (payload) => {
    // A pending local change wins over an older broadcast.
    if (store.changing) return;
    store.loaded = true;
    store.saved = parseSpinner((payload as { spinner?: unknown })?.spinner);
    publish(store, store.saved);
  });
  return value;
}

/**
 * Changes part of the style: shown at once, saved after a short pause, and
 * reverted to the last saved style if the server refuses it (`onError` then
 * runs). Changes merge into the latest style, not the caller's last render,
 * so quick successive picks all stick.
 */
export function useSetSpinner(
  onError: (cause: unknown) => void,
): (patch: Partial<SpinnerStyle>) => void {
  const rpc = useRpc<RpcContract>();
  const store = storeFor(rpc);
  return useCallback(
    (patch: Partial<SpinnerStyle>) => {
      publish(store, { ...store.value, ...patch });
      store.changing = true;
      if (store.timer) clearTimeout(store.timer);
      store.timer = setTimeout(() => {
        store.timer = null;
        const pending = store.value;
        rpc.call("setSpinner", { spinner: pending }).then(
          ({ spinner }) => {
            store.saved = parseSpinner(spinner);
            if (!store.timer) {
              store.changing = false;
              publish(store, store.saved);
            }
          },
          (cause: unknown) => {
            if (!store.timer) {
              store.changing = false;
              publish(store, store.saved);
            }
            onError(cause);
          },
        );
      }, SAVE_DELAY_MS);
    },
    [rpc, store, onError],
  );
}
