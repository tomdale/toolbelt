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
import type { Placement } from "../server/service.ts";
import type { MapRecord } from "../server/map.ts";
import type { ProposalView } from "../server/evolution.ts";
import { projectWorkstreams, type Projection } from "../domain/project.ts";
import { isCurrent, needsYou } from "../domain/analysis.ts";
import type { StoredAnalysis } from "../server/analyzer.ts";

export type ServerState = {
  workstreams: Record<string, MapRecord>;
  placements: Record<string, Placement>;
  analysis: Record<string, StoredAnalysis>;
  proposals: ProposalView[];
  driftDismissed: Record<string, string>;
  bootstrapped: boolean;
  lastReconciledAt: number | null;
};

const EMPTY: ServerState = {
  workstreams: {},
  placements: {},
  analysis: {},
  proposals: [],
  driftDismissed: {},
  bootstrapped: false,
  lastReconciledAt: null,
};

/**
 * The plugin's own state, refetched whenever the server publishes a change.
 * The sidebar, the page, and each thread header's banner share this shape.
 */
export function useServerState() {
  const rpc = useRpc<RpcContract>();
  const [server, setServer] = useState<ServerState>(EMPTY);
  const refresh = useCallback(async () => {
    try {
      setServer({ ...EMPTY, ...(await rpc.call("state", null)) });
    } catch {
      // Everything still renders from live BB data without plugin state.
    }
  }, [rpc]);
  useRealtime("changed", refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { rpc, server, refresh };
}

/** Pending or just-applied proposals that involve each thread. */
export function proposalsByThread(
  proposals: readonly ProposalView[],
): Map<string, ProposalView> {
  const out = new Map<string, ProposalView>();
  for (const proposal of proposals)
    for (const id of proposal.threadIds)
      if (!out.has(id) || proposal.status === "pending") out.set(id, proposal);
  return out;
}

/** What a row shows from analysis: nothing, a pending marker, or the result. */
export type WorkView =
  | { kind: "none" }
  | { kind: "pending"; previous: StoredAnalysis }
  | { kind: "current"; analysis: StoredAnalysis };

export function workView(
  thread: PluginSidebarThread,
  analysis: StoredAnalysis | undefined,
): WorkView {
  // A failed turn gets no analysis; BB's own error mark says enough.
  if (!analysis || thread.status === "error") return { kind: "none" };
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
  const { status, threads, sections, projects } =
    experimental_useSidebarThreads();
  const settings = useSettings();
  const now = useNow();
  const { rpc, server, refresh } = useServerState();

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
    proposalOf: proposalsByThread(server.proposals),
    now,
    rpc,
    refresh,
    showRecent: values.showRecent !== false,
    showParentThreadLink: values.showParentThreadLink === true,
  };
}

/**
 * A task thread's drift flag: a current, high-confidence analysis that the
 * latest request belongs elsewhere, not already dismissed for that target.
 */
export function driftOf(
  thread: { id: string; status: string; latestAttentionAt: number } | undefined,
  server: ServerState,
): { target: string; sectionId: string | null } | null {
  if (!thread) return null;
  const analysis = server.analysis[thread.id];
  if (!isCurrent(analysis, thread)) return null;
  const drift = analysis.drift;
  if (!drift || drift.confidence !== "high") return null;
  const key = analysis.driftSectionId ?? drift.newName ?? "";
  if (!key || server.driftDismissed[thread.id] === key) return null;
  const name =
    (analysis.driftSectionId
      ? server.workstreams[analysis.driftSectionId]?.name
      : null) ??
    drift.workstream ??
    drift.newName;
  return name ? { target: name, sectionId: analysis.driftSectionId } : null;
}
