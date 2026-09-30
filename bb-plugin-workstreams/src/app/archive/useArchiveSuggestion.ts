import { useEffect, useState } from "react";
import { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { isCurrent } from "../../domain/analysis.ts";
import { useServerState } from "../useWorkstreams.ts";

export function useArchiveSuggestion(threadId: string | null, enabled = true) {
  const { rpc, server, refresh } = useServerState();
  const { threads } = experimental_useSidebarThreads({
    experimental_lifecycles: ["active"],
  });
  const analysis = threadId ? server.analysis[threadId] : undefined;
  const thread = threads.find((t) => t.id === threadId);
  const [suggestion, setSuggestion] = useState<{
    threadId: string;
    revision: number | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision =
    suggestion?.threadId === threadId ? suggestion.revision : null;
  const key = `${threadId}:${revision}`;
  useEffect(() => {
    let canceled = false;
    setSuggestion(null);
    if (enabled && threadId && analysis?.state === "done") {
      void rpc
        .call("archiveStatus", { threadId })
        .then(({ revision }) => {
          if (!canceled) setSuggestion({ threadId, revision });
        })
        .catch(() => {});
    }
    return () => {
      canceled = true;
    };
  }, [
    enabled,
    threadId,
    analysis?.revision,
    analysis?.state,
    thread?.latestAttentionAt,
    thread?.status,
    thread?.runtimeStatus,
    thread?.queuedWork,
    thread?.hasPendingInteraction,
    thread?.isArchived,
    thread?.isHidden,
    thread?.activity.goals,
    thread?.activity.planMode,
    thread?.activity.backgroundAgents,
    thread?.activity.backgroundCommands,
    thread?.activity.workflows,
    rpc,
  ]);
  useEffect(() => {
    setError(null);
  }, [key]);

  const visible =
    enabled &&
    threadId !== null &&
    revision !== null &&
    thread !== undefined &&
    !thread.isArchived &&
    !thread.isHidden &&
    thread.runtimeStatus === "idle" &&
    thread.queuedWork === "none" &&
    !thread.hasPendingInteraction &&
    Object.values(thread.activity).every((count) => count === 0) &&
    isCurrent(analysis, thread) &&
    analysis.state === "done" &&
    analysis.revision === revision &&
    settled !== key;

  const decide = async (action: "archive" | "dismiss") => {
    if (!visible || !threadId || revision === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("archiveSuggestion", { threadId, revision, action });
      setSettled(key);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return { visible, busy, error, decide };
}
