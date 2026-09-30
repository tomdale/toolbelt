import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  useRealtime,
  useRpc,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";

/**
 * Header runners by thread, so the command palette entry can start the same
 * generation (with the same progress and error handling) as the button.
 */
export const headerGenerators = new Map<string, () => void>();

/** "Recap" in the thread header: generates a fresh recap on demand. */
export function RecapHeaderAction({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const rpc = useRpc<RpcContract>();
  const [generating, setGenerating] = useState(false);
  const refresh = useCallback(() => {
    void rpc
      .call("recap_get", { threadId })
      .then((value) => setGenerating(value.generating));
  }, [rpc, threadId]);
  useEffect(refresh, [refresh]);
  useRealtime("changed", refresh);
  const run = useCallback(() => {
    setGenerating(true);
    rpc
      .call("recap_generate", { threadId })
      .then((result) => {
        if (!result.generated)
          toast.error("Couldn't generate a recap for this thread yet.");
      })
      .catch((cause) =>
        toast.error(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(refresh);
  }, [refresh, rpc, threadId]);
  useEffect(() => {
    headerGenerators.set(threadId, run);
    return () => {
      if (headerGenerators.get(threadId) === run)
        headerGenerators.delete(threadId);
    };
  }, [run, threadId]);
  return (
    <button
      type="button"
      className="inline-flex h-7 cursor-pointer items-center justify-center rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
      aria-label={generating ? "Generating recap" : "Generate recap"}
      title={generating ? "Generating recap…" : "Generate recap"}
      disabled={generating}
      onClick={run}
    >
      {isCompactViewport ? "✦" : generating ? "Recapping…" : "Recap"}
    </button>
  );
}
