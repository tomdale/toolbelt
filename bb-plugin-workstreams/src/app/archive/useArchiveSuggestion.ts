import { useEffect, useRef, useState } from "react";
import {
  experimental_usePluginId,
  experimental_useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { isCurrent } from "../../domain/analysis.ts";
import { useServerState } from "../useWorkstreams.ts";

function readDismissed(storageKey: string): Set<string> {
  try {
    return new Set(
      JSON.parse(sessionStorage.getItem(storageKey) ?? "[]") as string[],
    );
  } catch {
    return new Set();
  }
}

export function useArchiveSuggestion(
  threadId: string | null,
  continuing = false,
) {
  const { rpc, server, refresh } = useServerState();
  const pluginId = experimental_usePluginId();
  const storageKey = `${pluginId}:archive-dismissed`;
  const dismissed = useRef(readDismissed(storageKey));
  const { threads } = experimental_useSidebarThreads({
    experimental_lifecycles: ["active"],
  });
  const analysis = threadId ? server.analysis[threadId] : undefined;
  const thread = threads.find((t) => t.id === threadId);
  const acceptsResult =
    analysis?.state === "done" || analysis?.state === "review";
  const [suggestion, setSuggestion] = useState<{
    threadId: string;
    revision: number | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision =
    suggestion?.threadId === threadId ? suggestion.revision : null;
  const key = `${threadId}:${analysis?.revision}`;
  const activeWork =
    thread !== undefined &&
    (thread.status !== "idle" ||
      thread.runtimeStatus !== "idle" ||
      thread.queuedWork !== "none" ||
      thread.hasPendingInteraction ||
      Object.values(thread.activity).some((count) => count > 0));

  useEffect(() => {
    if (
      !threadId ||
      !acceptsResult ||
      !(continuing || activeWork) ||
      busy ||
      dismissed.current.has(key)
    )
      return;
    // Continuation intent dismisses the analyzed turn even before archiveStatus
    // returns. Clearing the draft or remounting must not resurrect that button.
    dismissed.current.add(key);
    setSettled(key);
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify([...dismissed.current].slice(-100)),
      );
    } catch {}
  }, [
    threadId,
    acceptsResult,
    analysis?.revision,
    continuing,
    activeWork,
    busy,
    key,
    rpc,
    storageKey,
  ]);

  useEffect(() => {
    if (!threadId || !acceptsResult || !dismissed.current.has(key)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    const persist = async () => {
      try {
        await rpc.call("archiveSuggestion", {
          threadId,
          revision: analysis.revision,
          action: "dismiss",
        });
      } catch {
        if (disposed) return;
        // Retry while this analyzed turn is mounted; the local copy hides it
        // immediately and lets a remount retry after a connection failure.
        timer = setTimeout(() => void persist(), delay);
        delay = Math.min(delay * 2, 30000);
      }
    };
    void persist();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [threadId, acceptsResult, analysis?.revision, settled, key, rpc]);

  useEffect(() => {
    let canceled = false;
    setSuggestion(null);
    if (
      threadId &&
      acceptsResult &&
      !continuing &&
      !activeWork &&
      !dismissed.current.has(key)
    ) {
      void rpc
        .call("archiveStatus", { threadId })
        .then(({ revision }) => {
          if (!canceled && !dismissed.current.has(key))
            setSuggestion({ threadId, revision });
        })
        .catch(() => {});
    }
    return () => {
      canceled = true;
    };
  }, [
    threadId,
    analysis?.revision,
    acceptsResult,
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
    continuing,
    activeWork,
    key,
    rpc,
  ]);
  useEffect(() => {
    setError(null);
  }, [key]);

  const visible =
    !continuing &&
    !activeWork &&
    threadId !== null &&
    revision !== null &&
    thread !== undefined &&
    !thread.isArchived &&
    !thread.isHidden &&
    isCurrent(analysis, thread) &&
    acceptsResult &&
    analysis.revision === revision &&
    settled !== key &&
    !dismissed.current.has(key);

  const decide = async (action: "archive") => {
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
