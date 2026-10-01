import { useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../server/contract.ts";
import {
  mergePrefs,
  parsePrefs,
  type Prefs,
  type PrefsPatch,
} from "../domain/prefs.ts";

/**
 * Workstreams' preferences, kept current across windows by the `prefs`
 * realtime broadcast. Null until the first load. `save` applies the patch
 * locally first so controls respond immediately, and reverts if the server
 * rejects it.
 */
export function usePrefs() {
  const rpc = useRpc<RpcContract>();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  useEffect(() => {
    void rpc
      .call("prefs", null)
      .then(({ prefs }) => setPrefs(parsePrefs(prefs)))
      .catch(() => {});
  }, [rpc]);
  useRealtime("prefs", (payload) =>
    setPrefs(parsePrefs((payload as { prefs?: unknown })?.prefs)),
  );
  const save = async (patch: PrefsPatch) => {
    const before = prefs;
    if (before) setPrefs(mergePrefs(before, patch));
    try {
      const { prefs: saved } = await rpc.call("setPrefs", { patch });
      setPrefs(parsePrefs(saved));
    } catch (error) {
      setPrefs(before);
      throw error;
    }
  };
  return { prefs, save };
}
