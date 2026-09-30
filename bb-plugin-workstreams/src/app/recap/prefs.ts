import { useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import { parseRecapPrefs, type RecapPrefs } from "../../domain/recapPrefs.ts";

/**
 * The stored recap preferences, kept current across windows by the
 * `recapPrefs` realtime broadcast. `save` applies the change locally first so
 * controls respond immediately, and reverts if the server rejects it.
 */
export function useRecapPrefs() {
  const rpc = useRpc<RpcContract>();
  const [prefs, setPrefs] = useState<RecapPrefs | null>(null);
  useEffect(() => {
    void rpc
      .call("recapPrefs", null)
      .then(({ prefs }) => setPrefs(parseRecapPrefs(prefs)));
  }, [rpc]);
  useRealtime("recapPrefs", (payload) =>
    setPrefs(parseRecapPrefs((payload as { prefs?: unknown })?.prefs)),
  );
  const save = async (patch: Partial<RecapPrefs>) => {
    const before = prefs;
    if (before) setPrefs({ ...before, ...patch });
    try {
      const { prefs: saved } = await rpc.call("setRecapPrefs", { patch });
      setPrefs(parseRecapPrefs(saved));
    } catch (error) {
      setPrefs(before);
      throw error;
    }
  };
  return { prefs, save };
}
