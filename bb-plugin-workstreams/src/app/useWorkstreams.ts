/**
 * The single client-side model for the sidebar and the page (SPEC I8): BB's
 * live sidebar threads plus the plugin's own state, run through the shared
 * domain projection.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_useSidebarThreads,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { Placement } from "../server/service.ts";
import type { MapRecord } from "../server/map.ts";
import { projectWorkstreams, type Projection } from "../domain/project.ts";
import { isCurrent } from "../domain/analysis.ts";
import { reportedAnalysis, type Recap } from "../domain/recap.ts";
import type { ManualOrder } from "../domain/order.ts";
import type { StoredAnalysis } from "../server/analyzer.ts";
import type { CatalogState } from "../domain/corpus.ts";
import {
  isSnoozed,
  type SnoozePrefs,
  type ThreadSnooze,
} from "../domain/snooze.ts";
import { useSharedServerState } from "./serverState.ts";
import { usePrefs } from "./prefs.ts";

export type ServerState = {
  /**
   * The first read of plugin state has finished, whether or not it succeeded.
   * Until then every other field is its empty default, which is not what the
   * server holds; surfaces that would draw a wrong first frame wait for it.
   */
  ready?: boolean;
  workstreams: Record<string, MapRecord>;
  placements: Record<string, Placement>;
  analysis: Record<string, StoredAnalysis>;
  /** Agent recaps for each thread's latest turn. */
  recaps: Record<string, Recap>;
  driftDismissed: Record<string, string>;
  bootstrapped: boolean;
  lastReconciledAt: number | null;
  order: ManualOrder;
  snoozes: Record<string, ThreadSnooze>;
  snoozePrefs: SnoozePrefs;
  catalog?: CatalogState;
};

export type ReorderChange =
  | { kind: "workstreams"; ids: string[] }
  | { kind: "prioritized"; ids: string[] }
  | { kind: "threads"; groupId: string; ids: string[] };

/** Shared plugin state and optimistic actions for every UI consumer. */
export function useServerState() {
  return useSharedServerState();
}

/**
 * What a row shows of a thread's work: nothing, a pending marker, or the
 * current result. `reported` marks a result the thread's agent reported in
 * its recap rather than one analysis inferred.
 */
export type WorkView =
  | { kind: "none" }
  | { kind: "pending"; previous: StoredAnalysis }
  | { kind: "current"; analysis: StoredAnalysis; reported: boolean };

/**
 * The agent's recap of an idle thread's latest turn outranks analysis for
 * the work state and the row's one-line summary. Analysis still supplies
 * subject and drift when it is current.
 */
export function workView(
  thread: PluginSidebarThread,
  analysis: StoredAnalysis | undefined,
  recap?: Recap,
): WorkView {
  // A failed turn gets neither; BB's own error mark says enough.
  if (thread.status === "error") return { kind: "none" };
  if (recap && thread.status === "idle")
    return {
      kind: "current",
      reported: true,
      analysis: reportedAnalysis(
        recap,
        thread,
        isCurrent(analysis, thread) ? analysis : undefined,
      ),
    };
  if (!analysis) return { kind: "none" };
  return isCurrent(analysis, thread)
    ? { kind: "current", analysis, reported: false }
    : { kind: "pending", previous: analysis };
}

/** Needs you: a pending interaction, or a current needs-decision result. */
function needsYou(thread: PluginSidebarThread, work: WorkView): boolean {
  return (
    thread.hasPendingInteraction ||
    (work.kind === "current" && work.analysis.state === "needs_decision")
  );
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
  const { prefs } = usePrefs();
  const now = useNow();
  const { rpc, server, refresh, reorder, setSnooze } = useServerState();

  const { analysis, recaps, order, snoozes } = server;
  const projection: Projection<PluginSidebarThread> = useMemo(
    () =>
      projectWorkstreams(threads, sections, {
        now,
        needsYou: (thread) => {
          const work = workView(thread, analysis[thread.id], recaps[thread.id]);
          return (
            needsYou(thread, work) ||
            (thread.isUnread &&
              work.kind === "current" &&
              (work.analysis.state === "done" ||
                work.analysis.state === "review"))
          );
        },
        order,
        recentLimit: prefs?.sidebar.recentLimit,
        snoozedUntil: (thread) => {
          const snooze = snoozes[thread.id];
          return isSnoozed(snooze, thread, now) ? snooze!.until : undefined;
        },
      }),
    [
      threads,
      sections,
      now,
      analysis,
      recaps,
      order,
      snoozes,
      prefs?.sidebar.recentLimit,
    ],
  );
  return {
    status,
    projection,
    threads,
    sections,
    projects,
    server,
    work: (thread: PluginSidebarThread) =>
      workView(thread, analysis[thread.id], recaps[thread.id]),
    now,
    rpc,
    refresh,
    reorder,
    setSnooze,
    snoozeOf: (thread: PluginSidebarThread) => {
      const snooze = snoozes[thread.id];
      return isSnoozed(snooze, thread, now) ? snooze : undefined;
    },
    snoozePrefs: server.snoozePrefs,
    showForYou: prefs?.sidebar.showForYou ?? true,
    showRecent: prefs?.sidebar.showRecent ?? true,
    showSnoozed: prefs?.sidebar.showSnoozed ?? true,
    showArchived: prefs?.sidebar.showArchived ?? true,
    showParentThreadLink: prefs?.threads.showParentLink ?? false,
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
