/**
 * The Workstreams page: the Monday-morning view. Workstreams are ranked by
 * attention, then recency; each lists its threads to pick back up. The
 * Activity tab shows the journal.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useBbNavigate,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { rankGroups, type Group } from "../../domain/project.ts";
import { relativeAge } from "../../domain/presentation.ts";
import { StatusMark } from "../sidebar/StatusMark.tsx";
import { useWorkstreams } from "../useWorkstreams.ts";
import { Activity } from "./Activity.tsx";

type Tab = "overview" | "activity";

export function WorkstreamsPage() {
  const ws = useWorkstreams();
  const [tab, setTab] = useState<Tab>("overview");
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
              r.thread.displayTitle.toLowerCase().includes(q),
            ),
      }))
      .filter((g) => g.rows.length > 0);
  }, [projection, query]);

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
          <div role="tablist" className="flex gap-1 text-sm">
            {(["overview", "activity"] as const).map((id) => (
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
                {id === "overview" ? "Overview" : "Activity"}
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
            {ranked.map((group) => (
              <WorkstreamCard
                key={group.id}
                group={group}
                description={
                  ws.server.workstreams[group.id]?.description ?? null
                }
                now={ws.now}
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
          </div>
        ) : (
          <Activity rpc={ws.rpc} />
        )}
      </div>
    </div>
  );
}

function WorkstreamCard({
  group,
  description,
  now,
}: {
  group: Group<PluginSidebarThread>;
  description: string | null;
  now: number;
}) {
  const navigate = useBbNavigate();
  // Needs-you roots first, then the projection's order (pinned, then recent).
  const roots = group.rows
    .filter((r) => r.depth === 0)
    .sort((a, b) => Number(b.needsYou) - Number(a.needsYou));
  const childCount = new Map<string, number>();
  let currentRoot: string | null = null;
  for (const row of group.rows) {
    if (row.depth === 0) currentRoot = row.thread.id;
    else if (currentRoot)
      childCount.set(currentRoot, (childCount.get(currentRoot) ?? 0) + 1);
  }
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
        {roots.map((row) => (
          <li key={row.thread.id}>
            <button
              type="button"
              onClick={() => navigate.toThread(row.thread.id)}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-state-hover"
            >
              <StatusMark
                indicator={row.thread.indicator}
                label={row.thread.indicatorLabel}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  row.thread.isUnread ? "font-medium" : "text-foreground/90",
                )}
              >
                {row.thread.displayTitle}
              </span>
              {childCount.get(row.thread.id) ? (
                <span className="text-xs text-muted-foreground">
                  +{childCount.get(row.thread.id)} delegated
                </span>
              ) : null}
              <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                {relativeAge(row.thread.latestAttentionAt, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
