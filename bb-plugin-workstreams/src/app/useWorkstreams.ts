/**
 * The single client-side model for the sidebar and the page: BB's
 * live sidebar threads plus the plugin's own state, run through the shared
 * domain projection.
 */
import { useEffect, useMemo, useState } from "react";
import {
  experimental_useSidebarThreads,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { MapRecord } from "../server/map.ts";
import { projectWorkstreams, type Projection } from "../domain/project.ts";
import type { Recap } from "../domain/recap.ts";
import { needsAttention, upNextKind, workView } from "../domain/status.ts";
import type { ManualOrder } from "../domain/order.ts";
import { RECENT_LIMIT } from "../domain/prefs.ts";
import type { StoredAnalysis } from "../server/analyzer.ts";
import type { TopicState } from "../domain/topics.ts";
import type { WorkstreamTopics } from "../domain/groups.ts";
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
  /**
   * A read of plugin state has succeeded, so the fields hold what the server
   * stored rather than empty defaults. Editors that save whole values, such
   * as the snooze preset list, wait for it so a default can't replace them.
   */
  loaded?: boolean;
  workstreams: Record<string, MapRecord>;
  analysis: Record<string, StoredAnalysis>;
  /** Agent recaps for each thread's latest turn. */
  recaps: Record<string, Recap>;
  bootstrapped: boolean;
  lastReconciledAt: number | null;
  order: ManualOrder;
  snoozes: Record<string, ThreadSnooze>;
  snoozePrefs: SnoozePrefs;
  catalog?: TopicState;
};

export type ReorderChange =
  | { kind: "workstreams"; ids: string[] }
  | { kind: "prioritized"; ids: string[] }
  | { kind: "threads"; groupId: string; ids: string[] };

/** Shared plugin state and optimistic actions for every UI consumer. */
export function useServerState() {
  return useSharedServerState();
}

export { workView, type WorkView } from "../domain/status.ts";

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
  const { rpc, server, refresh, reorder, setSnoozes } = useServerState();

  const { analysis, recaps, order, snoozes, catalog } = server;
  /** What nests the workstreams (see `nestGroups`). */
  const topics: WorkstreamTopics | undefined = useMemo(
    () =>
      catalog
        ? { entities: catalog.entities, bindings: catalog.groups }
        : undefined,
    [catalog],
  );
  const projection: Projection<PluginSidebarThread> = useMemo(
    () =>
      projectWorkstreams(threads, sections, {
        now,
        needsYou: (thread) => {
          const work = workView(thread, analysis[thread.id], recaps[thread.id]);
          return needsAttention(thread, work);
        },
        order,
        snoozedUntil: (thread) => {
          const snooze = snoozes[thread.id];
          return isSnoozed(snooze, thread, now) ? snooze!.until : undefined;
        },
      }),
    [threads, sections, now, analysis, recaps, order, snoozes],
  );
  /**
   * What Up Next ranks threads by (see `selectUpNext`), less the focused
   * workstreams, which each surface resolves for itself.
   */
  const upNextOptions = useMemo(
    () => ({
      kindOf: (thread: PluginSidebarThread) =>
        upNextKind(
          thread,
          workView(thread, analysis[thread.id], recaps[thread.id]),
        ),
      now,
    }),
    [analysis, recaps, now],
  );
  return {
    status,
    projection,
    topics,
    threads,
    sections,
    projects,
    server,
    work: (thread: PluginSidebarThread) =>
      workView(thread, analysis[thread.id], recaps[thread.id]),
    upNextOptions,
    now,
    rpc,
    refresh,
    reorder,
    setSnoozes,
    snoozeOf: (thread: PluginSidebarThread) => {
      const snooze = snoozes[thread.id];
      return isSnoozed(snooze, thread, now) ? snooze : undefined;
    },
    snoozePrefs: server.snoozePrefs,
    showForYou: prefs?.sidebar.showForYou ?? true,
    showRecent: prefs?.sidebar.showRecent ?? true,
    recentLimit: prefs?.sidebar.recentLimit ?? RECENT_LIMIT.fallback,
    showSnoozed: prefs?.sidebar.showSnoozed ?? true,
    showArchived: prefs?.sidebar.showArchived ?? true,
    showParentThreadLink: prefs?.threads.showParentLink ?? false,
  };
}
