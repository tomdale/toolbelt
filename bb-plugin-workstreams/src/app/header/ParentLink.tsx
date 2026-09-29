import { useEffect, useState } from "react";
import {
  useBbNavigate,
  useRpc,
  useSettings,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";

/** Optional link from a child thread's header to its parent. */
export function ParentThreadLink({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { values } = useSettings();
  const enabled =
    (values as Record<string, unknown> | undefined)?.showParentThreadLink ===
    true;
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [result, setResult] = useState<{
    threadId: string;
    parent: { id: string; title: string } | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    setResult(null);
    let active = true;
    rpc.call("parentLink", { threadId }).then(
      (parent) => active && setResult({ threadId, parent }),
      () => active && setResult({ threadId, parent: null }),
    );
    return () => {
      active = false;
    };
  }, [enabled, rpc, threadId]);

  const parent =
    enabled && result?.threadId === threadId ? result.parent : null;
  if (!parent) return null;
  const label = `Go to parent thread: ${parent.title}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => navigate.toThread(parent.id)}
      className="inline-flex h-7 max-w-56 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
    >
      <span aria-hidden="true">↖</span>
      {isCompactViewport ? null : (
        <span className="truncate">{parent.title}</span>
      )}
    </button>
  );
}
