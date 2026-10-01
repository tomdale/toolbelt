/**
 * The Workstreams page: the Monday-morning view. Workstreams are ranked by
 * attention, then recency; each lists its threads to pick back up. The
 * Activity tab shows the journal.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useBbNavigate,
  type PluginNavPanelProps,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { rankGroups, type Group } from "../../domain/project.ts";
import {
  REPORTED_DONE,
  WORK_STATE,
  relativeAge,
  workStateMark,
} from "../../domain/presentation.ts";
import { StatusMark } from "../sidebar/StatusMark.tsx";
import { useWorkstreams, type WorkView } from "../useWorkstreams.ts";
import { Activity } from "./Activity.tsx";
import { MapTab } from "./MapTab.tsx";
import { NewWorkDialog } from "../composer/NewWork.tsx";
import { InspectButton } from "../debug/InspectButton.tsx";

type Tab = "overview" | "map" | "activity";
const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  map: "Map",
  activity: "Activity",
};

/**
 * `subPath` deep links select the map or activity view.
 * Model-call inspection lives in Activity and the Understanding workbench.
 */
function tabOf(subPath: string): { tab: Tab; focus: string | null } {
  const [head, ...rest] = subPath.split("/");
  if (head === "map") return { tab: "map", focus: null };
  if (head === "activity")
    return { tab: "activity", focus: rest.join("/") || null };
  if (head === "debug") return { tab: "activity", focus: null };
  return { tab: "overview", focus: null };
}

export function WorkstreamsPage({
  subPath = "",
}: Partial<PluginNavPanelProps>) {
  const ws = useWorkstreams();
  const linked = tabOf(subPath);
  const [tab, setTab] = useState<Tab>(linked.tab);
  const tabs: Tab[] = ["overview", "map", "activity"];
  const [newWork, setNewWork] = useState(false);
  useLayoutEffect(() => setTab(tabOf(subPath).tab), [subPath]);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || document.activeElement === search.current)
        return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      setTab("overview");
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { projection } = ws;
  const ranked = useMemo(() => {
    const groups = rankGroups(projection.groups);
    if (projection.unsorted.total > 0) groups.push(projection.unsorted);
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        rows: g.name.toLowerCase().includes(q)
          ? g.rows
          : g.rows.filter((r) =>
              `${r.thread.displayTitle} ${ws.server.analysis[r.thread.id]?.recap ?? ""}`
                .toLowerCase()
                .includes(q),
            ),
      }))
      .filter((g) => g.rows.length > 0);
  }, [projection, query, ws.server.analysis]);

  const threadCount = projection.rowOf.size;
  const needs = projection.needsYou.length;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-10 pt-4 md:px-6">
        <header className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">Workstreams</h1>
            <p className="text-xs text-muted-foreground">
              {threadCount} threads · {projection.groups.length} workstreams
              {needs ? ` · ${needs} need${needs === 1 ? "s" : ""} you` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setNewWork(true)}
            className="rounded-md border border-border px-2.5 py-1 text-sm hover:bg-state-hover"
          >
            ＋ New
          </button>
          <NewWorkDialog open={newWork} onClose={() => setNewWork(false)} />
          <div role="tablist" className="flex gap-1 text-sm">
            {tabs.map((id) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  "rounded-md px-2.5 py-1",
                  tab === id
                    ? "bg-state-active text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {TAB_LABEL[id]}
              </button>
            ))}
          </div>
          {tab === "overview" ? (
            <input
              ref={search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search  /"
              aria-label="Search threads and workstreams"
              className="h-8 w-48 rounded-md border border-input bg-transparent px-2 text-sm"
            />
          ) : null}
        </header>
        {tab === "overview" ? (
          <div className="mt-5 flex flex-col gap-6">
            {!ws.server.bootstrapped && ws.status === "ready" ? (
              <button
                type="button"
                onClick={() => setTab("map")}
                className="rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-state-hover"
              >
                <span className="font-medium">Organize your workstreams</span>
                <span className="block text-xs text-muted-foreground">
                  One reviewed pass files your threads; Workstreams keeps them
                  current after that.
                </span>
              </button>
            ) : null}
            {ranked.map((group) => (
              <WorkstreamCard
                key={group.id}
                group={group}
                description={
                  ws.server.workstreams[group.id]?.description ?? null
                }
                now={ws.now}
                work={ws.work}
                via={projection.needsYouVia}
              />
            ))}
            {ranked.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {query ? "No matches." : "No active threads."}
              </p>
            ) : null}
            {projection.dormant.length > 0 && !query ? (
              <p className="text-xs text-muted-foreground">
                Dormant: {projection.dormant.map((g) => g.name).join(", ")}
              </p>
            ) : null}
            <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              {[
                ...Object.entries(WORK_STATE),
                ["complete", REPORTED_DONE] as const,
              ]
                .filter(([, v]) => v.glyph)
                .map(([key, v]) => (
                  <span key={key}>
                    <span className={`ws-work ws-work-${key}`}>{v.glyph}</span>{" "}
                    {v.label}
                  </span>
                ))}
              <span>Italic: updating after new activity</span>
            </p>
          </div>
        ) : tab === "map" ? (
          <MapTab
            rpc={ws.rpc}
            records={Object.values(ws.server.workstreams)}
            bootstrapped={ws.server.bootstrapped}
          />
        ) : (
          <Activity
            rpc={ws.rpc}
            focus={linked.tab === "activity" ? linked.focus : null}
            sections={ws.sections}
            workstreamOf={(id) =>
              ws.projection.rowOf.get(id)?.workstreamId ?? null
            }
          />
        )}
      </div>
    </div>
  );
}

function WorkstreamCard({
  group,
  description,
  now,
  work,
  via,
}: {
  group: Group<PluginSidebarThread>;
  description: string | null;
  now: number;
  work: (thread: PluginSidebarThread) => WorkView;
  via: ReadonlyMap<string, readonly PluginSidebarThread[]>;
}) {
  const navigate = useBbNavigate();
  const childCount = new Map<string, number>();
  // A delegate's own question, surfaced on its root row: the page lists
  // roots only, and folded questions already show on the parent.
  const childAsk = new Map<string, PluginSidebarThread>();
  const foldedIds = new Set(
    [...via.values()].flat().map((thread) => thread.id),
  );
  let currentRoot: string | null = null;
  for (const row of group.rows) {
    if (row.depth === 0) currentRoot = row.thread.id;
    else if (currentRoot) {
      childCount.set(currentRoot, (childCount.get(currentRoot) ?? 0) + 1);
      if (
        row.needsYou &&
        !foldedIds.has(row.thread.id) &&
        !childAsk.has(currentRoot)
      )
        childAsk.set(currentRoot, row.thread);
    }
  }
  // Roots needing you (themselves or through a delegate) first, then the
  // projection's order (pinned, then recent).
  const asks = (row: (typeof group.rows)[number]) =>
    row.needsYou || childAsk.has(row.thread.id);
  const roots = group.rows
    .filter((r) => r.depth === 0)
    .sort((a, b) => Number(asks(b)) - Number(asks(a)));
  return (
    <section aria-label={group.name}>
      <div className="flex items-baseline gap-2 border-b border-border pb-1">
        <h2 className="text-sm font-semibold">{group.name}</h2>
        <span className="text-xs text-muted-foreground">
          {group.total} thread{group.total === 1 ? "" : "s"}
          {group.needsYou
            ? ` · ${group.needsYou} need${group.needsYou === 1 ? "s" : ""} you`
            : ""}
          {group.lastActiveAt
            ? ` · ${relativeAge(group.lastActiveAt, now)}`
            : ""}
        </span>
      </div>
      {description ? (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      ) : null}
      <ul className="mt-1">
        {roots.map((row) => {
          const view = work(row.thread);
          const state =
            view.kind === "current"
              ? workStateMark(view.analysis.state, view.reported)
              : null;
          const folded = via.get(row.thread.id);
          return (
            <li
              key={row.thread.id}
              className="group/row flex items-center gap-1"
            >
              <button
                type="button"
                onClick={() => navigate.toThread(row.thread.id)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-state-hover"
              >
                <StatusMark
                  indicator={row.thread.indicator}
                  label={row.thread.indicatorLabel}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn(
                      "flex min-w-0 items-center gap-1.5",
                      row.thread.isUnread
                        ? "font-medium"
                        : "text-foreground/90",
                    )}
                  >
                    {state?.glyph && view.kind === "current" ? (
                      <span
                        className={`ws-work ws-work-${view.reported && view.analysis.state === "done" ? "complete" : view.analysis.state} inline-flex size-3.5 shrink-0 items-center justify-center`}
                        role="img"
                        aria-label={state.label}
                        title={state.label}
                      >
                        {state.glyph}
                      </span>
                    ) : null}
                    <span className="min-w-0 truncate">
                      {row.thread.displayTitle}
                    </span>
                  </span>
                  <WhereItStopped
                    view={view}
                    folded={folded}
                    child={childAsk.get(row.thread.id)}
                    work={work}
                  />
                </span>
                {childCount.get(row.thread.id) ? (
                  <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                    +{childCount.get(row.thread.id)} child{" "}
                    {childCount.get(row.thread.id) === 1 ? "thread" : "threads"}
                  </span>
                ) : null}
                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                  {relativeAge(row.thread.latestAttentionAt, now)}
                </span>
              </button>
              <InspectButton
                target={{ link: { kind: "thread", ref: row.thread.id } }}
                title={`Model calls for ${row.thread.displayTitle}`}
                label={`Inspect model calls for ${row.thread.displayTitle}`}
                className="text-muted-foreground opacity-0 group-hover/row:opacity-55 focus-visible:opacity-100"
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The row's second line: the ask when it needs you, else the recap. */
function WhereItStopped({
  view,
  folded,
  child,
  work,
}: {
  view: WorkView;
  folded: readonly PluginSidebarThread[] | undefined;
  child: PluginSidebarThread | undefined;
  work: (thread: PluginSidebarThread) => WorkView;
}) {
  const analysis =
    view.kind === "current"
      ? view.analysis
      : view.kind === "pending"
        ? view.previous
        : null;
  const ownAsk = view.kind === "current" ? view.analysis.needsYou : null;
  if (ownAsk)
    return (
      <span className="truncate text-xs text-muted-foreground">
        {ownAsk}
        {folded?.length ? ` (via ${folded[0]!.displayTitle})` : ""}
      </span>
    );
  if (child) {
    const childView = work(child);
    const ask =
      childView.kind === "current" ? childView.analysis.needsYou : null;
    return (
      <span className="truncate text-xs text-muted-foreground">
        via {child.displayTitle}: {ask ?? "waiting for you"}
      </span>
    );
  }
  if (!analysis) return null;
  return (
    <span
      className={cn(
        "truncate text-xs text-muted-foreground",
        view.kind === "pending" && "italic opacity-70",
      )}
    >
      {analysis.recap}
    </span>
  );
}
