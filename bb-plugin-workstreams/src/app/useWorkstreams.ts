/**
 * The single client-side model for the sidebar and the page (SPEC I8): BB's
 * live sidebar threads plus the plugin's own state, run through the shared
 * domain projection.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  useSettings,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../server/contract.ts";
import type { Placement, WorkstreamRecord } from "../server/service.ts";
import { projectWorkstreams, type Projection } from "../domain/project.ts";
import { isCurrent, needsYou } from "../domain/analysis.ts";
import type { StoredAnalysis } from "../server/analyzer.ts";

export type ServerState = {
  workstreams: Record<string, WorkstreamRecord>;
  placements: Record<string, Placement>;
  analysis: Record<string, StoredAnalysis>;
  lastReconciledAt: number | null;
};

const EMPTY: ServerState = {
  workstreams: {},
  placements: {},
  analysis: {},
  lastReconciledAt: null,
};

/** What a row shows from analysis: nothing, a pending marker, or the result. */
export type WorkView =
  | { kind: "none" }
  | { kind: "pending"; previous: StoredAnalysis }
  | { kind: "current"; analysis: StoredAnalysis };

export function workView(
  thread: PluginSidebarThread,
  analysis: StoredAnalysis | undefined,
): WorkView {
  if (!analysis) return { kind: "none" };
  return isCurrent(analysis, thread)
    ? { kind: "current", analysis }
    : { kind: "pending", previous: analysis };
}

/** Re-renders once a minute so ages and dormancy stay current. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useWorkstreams() {
  const rpc = useRpc<RpcContract>();
  const { status, threads, sections, projects } =
    experimental_useSidebarThreads();
  const settings = useSettings();
  const now = useNow();
  const [server, setServer] = useState<ServerState>(EMPTY);

  const refresh = useCallback(async () => {
    try {
      setServer(await rpc.call("state", null));
    } catch {
      // The list still works from live BB data without plugin state.
    }
  }, [rpc]);
  useRealtime("changed", refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { analysis } = server;
  const projection: Projection<PluginSidebarThread> = useMemo(
    () =>
      projectWorkstreams(threads, sections, {
        now,
        needsYou: (thread) => needsYou(thread, analysis[thread.id]),
      }),
    [threads, sections, now, analysis],
  );
  const values = (settings.values ?? {}) as Record<string, unknown>;
  return {
    status,
    projection,
    sections,
    projects,
    server,
    work: (thread: PluginSidebarThread) =>
      workView(thread, analysis[thread.id]),
    now,
    rpc,
    refresh,
    showRecent: values.showRecent !== false,
    showParentThreadLink: values.showParentThreadLink === true,
  };
}
