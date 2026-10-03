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
  relativeAge,
  statusRole,
  workStateMark,
} from "../../domain/presentation.ts";
import { Icon } from "@/components/ui/icon";
import { primaryButton } from "./controls.ts";
import { StatusMark } from "../sidebar/StatusMark.tsx";
import { useWorkstreams, type WorkView } from "../useWorkstreams.ts";
import { Activity } from "./Activity.tsx";
import { MapTab } from "./MapTab.tsx";
import { Catalog } from "./Catalog.tsx";
import { NewWorkDialog } from "../composer/NewWork.tsx";
import { InspectButton } from "../debug/InspectButton.tsx";
import { WorkstreamName } from "../WorkstreamName.tsx";
import { WorkstreamIcon } from "../WorkstreamIcon.tsx";

type Tab = "overview" | "catalog" | "map" | "activity";
const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  catalog: "Catalog",
  map: "Organize",
  activity: "Activity",
};

/**
 * `subPath` deep links select the map or activity view.
 */
function tabOf(subPath: string): {
  tab: Tab;
  focus: string | null;
  modelCalls?: boolean;
} {
  const [head, ...rest] = subPath.split("/");
  if (head === "catalog") return { tab: "catalog", focus: null };
  if (head === "map") return { tab: "map", focus: null };
  if (head === "activity")
    return { tab: "activity", focus: rest.join("/") || null };
  if (head === "debug")
    return { tab: "activity", focus: null, modelCalls: true };
  return { tab: "overview", focus: null };
}

export function WorkstreamsPage({
  subPath = "",
}: Partial<PluginNavPanelProps>) {
  const ws = useWorkstreams();
  const navigate = useBbNavigate();
  const linked = tabOf(subPath);
  const [tab, setTab] = useState<Tab>(linked.tab);
  const tabs: Tab[] = ["overview", "catalog", "map", "activity"];
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
      <div className="mx-auto box-border w-full max-w-3xl px-5 pb-16 pt-6 md:px-8">
        <header className="flex flex-wrap items-center gap-3 gap-y-2">
          <h1 className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight">
            <WorkstreamIcon className="size-4 text-foreground" />
            Workstreams
          </h1>
          <div
            role="tablist"
            aria-label="Workstreams views"
            className="flex rounded-lg bg-state-hover/60 p-0.5 text-[13px]"
          >
            {tabs.map((id) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  "rounded-md px-2.5 py-0.5 transition-colors",
                  tab === id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {TAB_LABEL[id]}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setNewWork(true)}
            className={primaryButton}
          >
            New work…
          </button>
          <NewWorkDialog open={newWork} onClose={() => setNewWork(false)} />
        </header>
        {tab === "overview" ? (
          <div className="mt-6">
            <label className="flex h-8 items-center gap-2 rounded-md border border-input px-2.5 text-sm focus-within:border-ring">
              <Icon
                name="Search"
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <input
                ref={search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                aria-label="Search threads and workstreams"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              />
              <kbd className="rounded border border-border px-1 font-sans text-[11px] text-muted-foreground">
                /
              </kbd>
            </label>
            {!ws.server.bootstrapped && ws.status === "ready" ? (
              <button
                type="button"
                onClick={() => setTab("map")}
                className="mt-6 w-full rounded-lg border border-border px-4 py-3 text-left text-sm hover:bg-state-hover"
              >
                <span className="font-medium">Organize your workstreams</span>
                <span className="block text-xs text-muted-foreground">
                  One reviewed pass groups your open threads by product.
                </span>
              </button>
            ) : null}
            <div className="mt-6 flex flex-col gap-7">
              {ranked.map((group) => (
                <WorkstreamCard
                  key={group.id}
                  group={group}
                  now={ws.now}
                  work={ws.work}
                  via={projection.needsYouVia}
                />
              ))}
            </div>
            {ranked.length === 0 ? (
              <p className="mt-10 text-center text-sm text-muted-foreground">
                {query ? "No matches." : "No open threads."}
              </p>
            ) : null}
            {projection.dormant.length > 0 && !query ? (
              <details className="group mt-8 text-xs text-muted-foreground">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <Icon
                    name="ChevronRight"
                    className="size-3 transition-transform group-open:rotate-90"
                    aria-hidden
                  />
                  {projection.dormant.length} quiet workstream
                  {projection.dormant.length === 1 ? "" : "s"}
                </summary>
                <p className="mt-2 pl-4 leading-relaxed">
                  {projection.dormant.map((g) => g.name).join(" · ")}
                </p>
              </details>
            ) : null}
          </div>
        ) : tab === "catalog" ? (
          <Catalog
            rpc={ws.rpc}
            serverCatalog={ws.server.catalog}
            sections={ws.sections}
            threads={ws.threads}
            navigate={navigate}
          />
        ) : tab === "map" ? (
          <MapTab
            rpc={ws.rpc}
            records={Object.values(ws.server.workstreams)}
            bootstrapped={ws.server.bootstrapped}
            onShowActivity={() => setTab("activity")}
          />
        ) : (
          <Activity
            rpc={ws.rpc}
            focus={linked.tab === "activity" ? linked.focus : null}
            modelCalls={linked.modelCalls ?? false}
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
  now,
  work,
  via,
}: {
  group: Group<PluginSidebarThread>;
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
      <div className="flex items-baseline gap-2 px-2 pb-1.5">
        <h2 className="min-w-0 text-[13px] font-semibold">
          <WorkstreamName name={group.name} />
        </h2>
        {group.needsYou ? (
          <span className="ws-amber-pill rounded-full px-1.5 text-[11px] font-medium tabular-nums">
            {group.needsYou}
          </span>
        ) : null}
        <span className="text-[12px] tabular-nums text-muted-foreground">
          {group.total}
        </span>
      </div>
      <ul>
        {roots.map((row) => {
          const view = work(row.thread);
          const state =
            view.kind === "current"
              ? workStateMark(view.analysis.state, view.reported)
              : null;
          const children = childCount.get(row.thread.id) ?? 0;
          const runtime = statusRole(row.thread.indicator);
          return (
            <li key={row.thread.id} className="group/row relative">
              <button
                type="button"
                onClick={() => navigate.toThread(row.thread.id)}
                className="grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-baseline gap-x-2.5 rounded-md px-2 py-1.5 text-left hover:bg-state-hover"
              >
                <span className="flex h-4 items-center justify-center self-start pt-0.5">
                  {runtime ? (
                    <StatusMark
                      indicator={row.thread.indicator}
                      label={row.thread.indicatorLabel}
                    />
                  ) : state?.glyph && view.kind === "current" ? (
                    <span
                      className={`ws-work ws-work-${view.reported && view.analysis.state === "done" ? "complete" : view.analysis.state} text-[11px]`}
                      role="img"
                      aria-label={state.label}
                      title={state.label}
                    >
                      {state.glyph}
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span
                    className={cn(
                      "flex min-w-0 items-baseline gap-1.5 text-[13px]",
                      row.thread.isUnread
                        ? "font-medium text-foreground"
                        : "text-foreground/90",
                    )}
                  >
                    <span className="min-w-0 truncate">
                      {row.thread.displayTitle}
                    </span>
                    {children ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        +{children} child{" "}
                        {children === 1 ? "thread" : "threads"}
                      </span>
                    ) : null}
                  </span>
                  <WhereItStopped
                    view={view}
                    folded={via.get(row.thread.id)}
                    child={childAsk.get(row.thread.id)}
                    work={work}
                  />
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {relativeAge(row.thread.latestAttentionAt, now)}
                </span>
              </button>
              <InspectButton
                target={{ link: { kind: "thread", ref: row.thread.id } }}
                title={`Model calls for ${row.thread.displayTitle}`}
                label={`Inspect model calls for ${row.thread.displayTitle}`}
                className="absolute right-10 top-1.5 text-muted-foreground opacity-0 group-hover/row:opacity-60 focus-visible:opacity-100"
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
      <span className="block truncate text-xs text-amber-600 dark:text-amber-400">
        {ownAsk}
        {folded?.length ? ` (via ${folded[0]!.displayTitle})` : ""}
      </span>
    );
  if (child) {
    const childView = work(child);
    const ask =
      childView.kind === "current" ? childView.analysis.needsYou : null;
    return (
      <span className="block truncate text-xs text-amber-600 dark:text-amber-400">
        via {child.displayTitle}: {ask ?? "waiting for you"}
      </span>
    );
  }
  if (!analysis) return null;
  return (
    <span
      className={cn(
        "block truncate text-xs text-muted-foreground",
        view.kind === "pending" && "opacity-60",
      )}
    >
      {analysis.recap}
    </span>
  );
}
