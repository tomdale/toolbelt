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

export type ServerState = {
  workstreams: Record<string, WorkstreamRecord>;
  placements: Record<string, Placement>;
  lastReconciledAt: number | null;
};

const EMPTY: ServerState = {
  workstreams: {},
  placements: {},
  lastReconciledAt: null,
};

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

  const projection: Projection<PluginSidebarThread> = useMemo(
    () => projectWorkstreams(threads, sections, { now }),
    [threads, sections, now],
  );
  const values = (settings.values ?? {}) as Record<string, unknown>;
  return {
    status,
    projection,
    sections,
    projects,
    server,
    now,
    rpc,
    refresh,
    showRecent: values.showRecent !== false,
    showParentThreadLink: values.showParentThreadLink === true,
  };
}
