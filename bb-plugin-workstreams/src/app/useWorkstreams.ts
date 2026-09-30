/**
 * The single client-side model for the sidebar and the page (SPEC I8): BB's
 * live sidebar threads plus the plugin's own state, run through the shared
 * domain projection.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_useSidebarThreads,
  useSettings,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { Placement } from "../server/service.ts";
import type { MapRecord } from "../server/map.ts";
import type { ProposalView } from "../server/evolution.ts";
import { projectWorkstreams, type Projection } from "../domain/project.ts";
import { isCurrent, needsYou } from "../domain/analysis.ts";
import type { ManualOrder } from "../domain/order.ts";
import type { StoredAnalysis } from "../server/analyzer.ts";
import { isSnoozed, type SnoozePrefs, type ThreadSnooze } from "../domain/snooze.ts";
import { useSharedServerState } from "./serverState.ts";

export type ServerState = {
  workstreams: Record<string, MapRecord>;
  placements: Record<string, Placement>;
  analysis: Record<string, StoredAnalysis>;
  proposals: ProposalView[];
  driftDismissed: Record<string, string>;
  bootstrapped: boolean;
  lastReconciledAt: number | null;
  order: ManualOrder;
  snoozes: Record<string, ThreadSnooze>;
  snoozePrefs: SnoozePrefs;
};

export type ReorderChange =
  | { kind: "workstreams"; ids: string[] }
  | { kind: "threads"; groupId: string; ids: string[] };

/** Shared plugin state and optimistic actions for every UI consumer. */
export function useServerState() {
  return useSharedServerState();
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
  const { rpc, server, refresh, reorder, setSnooze } = useServerState();

  // Moves in flight, by thread: the section the thread is headed to. The row
  // shows there until BB's live list catches up, or the move fails.
  const [moving, setMoving] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );
  const settle = useCallback((threadId: string) => {
    setMoving((prev) => {
      if (!prev.has(threadId)) return prev;
      const next = new Map(prev);
      next.delete(threadId);
      return next;
    });
  }, []);
  useEffect(() => {
    for (const thread of threads)
      if (moving.has(thread.id) && moving.get(thread.id) === thread.sectionId)
        settle(thread.id);
  }, [threads, moving, settle]);
  const moveThread = useCallback(
    async (threadId: string, sectionId: string | null) => {
      setMoving((prev) => new Map(prev).set(threadId, sectionId));
      try {
        await rpc.call("moveThread", { threadId, sectionId });
      } catch (cause) {
        settle(threadId);
        throw cause;
      }
    },
    [rpc, settle],
  );
  const placed = useMemo(
    () =>
      moving.size === 0
        ? threads
        : threads.map((thread) =>
            moving.has(thread.id)
              ? { ...thread, sectionId: moving.get(thread.id)! }
              : thread,
          ),
    [threads, moving],
  );

  const { analysis, order, snoozes } = server;
  const projection: Projection<PluginSidebarThread> = useMemo(
    () =>
      projectWorkstreams(placed, sections, {
        now,
        needsYou: (thread) => needsYou(thread, analysis[thread.id]),
        order,
        snoozedUntil: (thread) => {
          const snooze = snoozes[thread.id];
          return isSnoozed(snooze, thread, now) ? snooze!.until : undefined;
        },
      }),
    [placed, sections, now, analysis, order, snoozes],
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
    reorder,
    moveThread,
    setSnooze,
    snoozeOf: (thread: PluginSidebarThread) => {
      const snooze = snoozes[thread.id];
      return isSnoozed(snooze, thread, now) ? snooze : undefined;
    },
    snoozePrefs: server.snoozePrefs,
    showForYou: values.showForYou !== false,
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
