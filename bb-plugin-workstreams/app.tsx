import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, View } from "./server";
import {
  UNCLASSIFIED,
  groupThreads,
  type Row,
  type Snapshot,
  type WorkState,
} from "./model";
import { Button } from "./components/ui/button";
import "./app.css";
import { WorkstreamsThreadList } from "./sidebar";

const FRESHNESS: Record<Row["freshness"], string | null> = {
  current: null,
  changed: "Updated since analysis",
  failed: "Not refreshed",
  new: "Not analyzed",
};
const STATE_LABEL: Record<WorkState, string> = {
  needs_decision: "Needs decision",
  ready_for_review: "Ready for review",
  blocked: "Blocked",
  in_progress: "In progress",
  done: "Done",
};
const RUNTIME: Record<string, string> = {
  active: "Running",
  starting: "Starting",
  error: "Error",
  failed: "Error",
};

function when(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
const OTHER = "Other groups";
const anchor = (name: string) =>
  `ws-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

function ListRow({
  row,
  group,
  groupSummary,
  groupBanner,
  open,
  split,
}: {
  row: Row;
  group?: string;
  groupSummary?: { about: string; status: string };
  groupBanner?: string;
  open: () => void;
  /** Offered for detected side quests not yet split. */
  split?: () => void;
}) {
  const { thread, title, recap, freshness, state } = row;
  const runtime = RUNTIME[thread.status];
  const tag = FRESHNESS[freshness];
  return (
    <li>
      <button
        className={`ws-line ws-line-${state ?? "none"}${row.needsYou ? " ws-line-you" : ""}`}
        title={thread.title}
        onClick={open}
      >
        <span className={`ws-line-state ws-state-${state ?? "none"}`}>
          {state ? STATE_LABEL[state] : ""}
        </span>
        <span className="ws-line-body">
          {group && (
            <span className="ws-line-group-wrap">
              <span className="ws-line-group">{group}</span>
              {groupSummary && (
                <span className="ws-single-summary">
                  {groupSummary.about} {groupSummary.status}
                </span>
              )}
              {groupBanner && (
                <img className="ws-single-banner" src={groupBanner} alt="" />
              )}
            </span>
          )}
          <strong>{title}</strong>
          {recap && <span className="ws-recap"> {recap}</span>}
          {runtime && (
            <span className={`ws-tag ws-runtime-${thread.status}`}>
              {runtime}
            </span>
          )}
          {tag && <span className="ws-tag ws-tag-muted">{tag}</span>}
        </span>
        <span className="ws-when">{when(thread.updatedAt)}</span>
      </button>
      {split && row.drift && (
        <p className="ws-drift">
          Side quest: started as {row.drift.from} work, moved to {row.drift.to}.
          <button onClick={split}>
            Split into “{row.drift.mainlineTitle}” + “{row.drift.sideTitle}”
          </button>
        </p>
      )}
    </li>
  );
}

function GroupHeader({
  name,
  count,
  summary,
  banner,
}: {
  name: string;
  count: number;
  summary?: { about: string; status: string };
  banner?: string;
}) {
  return (
    <header className={`ws-group-head${banner ? " ws-has-banner" : ""}`}>
      {banner && <img className="ws-banner" src={banner} alt="" />}
      <h2>
        {name} <span>{count}</span>
      </h2>
      {summary && (
        <>
          <p className="ws-about">{summary.about}</p>
          <p className="ws-status-line">{summary.status}</p>
        </>
      )}
    </header>
  );
}

function WorkstreamsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [data, setData] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyYou, setOnlyYou] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const n = ++sequence.current;
    try {
      const next = await rpc.call("snapshot");
      if (n === sequence.current) {
        setData(next);
        setError("");
      }
    } catch (e) {
      if (n === sequence.current) setError(String(e));
    }
  }, [rpc]);
  const connection = useRealtimeConnectionState();
  useRealtime("changed", refresh);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== search.current) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKey);
    return () => {
      sequence.current++;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh, connection]);
  const call = async (
    method: "analyze" | "cancel" | "organize" | "split" | "undo",
    input: unknown = null,
  ) => {
    setBusy(true);
    setError("");
    try {
      await (rpc.call as (m: string, i: unknown) => Promise<unknown>)(
        method,
        input,
      );
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const all = data ? groupThreads(data) : [];
  const needsYou = all.reduce(
    (n, [, rows]) => n + rows.filter((r) => r.needsYou).length,
    0,
  );
  const q = query.trim().toLowerCase();
  const groups = all
    .map(
      ([name, rows]) =>
        [
          name,
          rows.filter(
            (r) =>
              (!onlyYou || r.needsYou) &&
              `${name} ${r.title} ${r.thread.title} ${r.thread.project} ${r.recap ?? ""} ${data?.analysis?.summaries[name]?.about ?? ""} ${data?.analysis?.summaries[name]?.status ?? ""}`
                .toLowerCase()
                .includes(q),
          ),
        ] as const,
    )
    .filter(([, rows]) => rows.length);
  const stats = data?.analysis?.stats;
  const splitDone = new Set(
    (data?.log ?? [])
      .filter(
        (e) => e.action.kind === "split" && e.result === "done" && !e.undone,
      )
      .map((e) => e.action.threadId),
  );
  const splitFor = (row: Row) =>
    row.drift &&
    row.drift.confidence !== "low" &&
    !splitDone.has(row.thread.id) &&
    row.freshness === "current"
      ? () => void call("split", { threadId: row.thread.id })
      : undefined;
  // In the list, one-thread groups share a section so they don't each need a header.
  const multi = groups.filter(
    ([name, rows]) => rows.length > 1 || name === UNCLASSIFIED,
  );
  const singles = groups.filter(
    ([name, rows]) => rows.length === 1 && name !== UNCLASSIFIED,
  );
  return (
    <main className="ws-page">
      <div className="ws-wrap">
        <header className="ws-header">
          <div>
            <h1>Workstreams</h1>
            {data && (
              <p className="ws-muted">
                {data.threads.length} active threads · {all.length} groups ·{" "}
                {data.analysis
                  ? `analyzed ${when(data.analysis.at)} ${new Date(data.analysis.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                  : "grouped by BB project until analyzed"}
              </p>
            )}
          </div>
          <div className="ws-actions">
            <input
              ref={search}
              className="ws-search"
              aria-label="Search threads"
              placeholder="Search  /"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {data?.progress ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void call("cancel")}
              >
                Cancel
              </Button>
            ) : null}
            {data?.analysis && (
              <Button
                variant="outline"
                disabled={busy || !!data.progress || data.organizing}
                onClick={() => void call("organize")}
              >
                {data.organizing ? "Organizing…" : "Organize"}
              </Button>
            )}
            <Button
              disabled={
                !data || busy || !!data.progress || !data.threads.length
              }
              onClick={() => void call("analyze")}
            >
              Analyze threads
            </Button>
          </div>
        </header>
        {data?.fixture && (
          <p className="ws-notice">
            Replaying frozen snapshot {data.fixture}, not live threads.
          </p>
        )}
        {(error || data?.error) && (
          <div role="alert" className="ws-notice ws-error">
            {error || data?.error}
            <Button variant="ghost" size="sm" onClick={() => void refresh()}>
              Reload
            </Button>
          </div>
        )}
        {data?.progress && (
          <p role="status" className="ws-notice">
            {data.progress.stage === "reading"
              ? "Reading threads"
              : "Classifying"}
            {data.progress.total > 0 &&
              ` · ${data.progress.completed}/${data.progress.total}`}
          </p>
        )}
        {!data ? (
          <p role="status">Loading active threads…</p>
        ) : (
          <>
            {(all.length > 1 || needsYou > 0) && (
              <nav className="ws-nav" aria-label="Groups">
                {needsYou > 0 && (
                  <button
                    className="ws-chip ws-chip-you"
                    aria-pressed={onlyYou}
                    onClick={() => setOnlyYou(!onlyYou)}
                  >
                    Needs you <span>{needsYou}</span>
                  </button>
                )}
                {[
                  ...multi.map(([name, rows]) => [name, rows.length] as const),
                  ...(singles.length ? [[OTHER, singles.length] as const] : []),
                ].map(([name, count]) => (
                  <button
                    key={name}
                    className="ws-chip"
                    onClick={() =>
                      document
                        .getElementById(anchor(name))
                        ?.scrollIntoView({ block: "start" })
                    }
                  >
                    {name} <span>{count}</span>
                  </button>
                ))}
              </nav>
            )}
            {!data.threads.length && (
              <p className="ws-notice">
                No active threads. Archived and hidden threads don’t appear
                here.
              </p>
            )}
            {!!data.threads.length && !groups.length && (
              <p className="ws-notice">No matching threads.</p>
            )}
            <div className="ws-list">
              {multi.map(([name, rows]) => (
                <section key={name} id={anchor(name)} aria-label={name}>
                  <GroupHeader
                    name={name}
                    count={rows.length}
                    summary={data.analysis?.summaries[name]}
                    banner={data.banners[name]}
                  />
                  <ul>
                    {rows.map((row) => (
                      <ListRow
                        key={row.thread.id}
                        row={row}
                        open={() => navigate.toThread(row.thread.id)}
                        split={splitFor(row)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
              {!!singles.length && (
                <section id={anchor(OTHER)} aria-label="Other groups">
                  <h2>
                    Other groups <span>{singles.length}</span>
                  </h2>
                  <ul>
                    {singles.map(([name, [row]]) => (
                      <ListRow
                        key={row.thread.id}
                        row={row}
                        group={name}
                        groupSummary={data.analysis?.summaries[name]}
                        groupBanner={data.banners[name]}
                        open={() => navigate.toThread(row.thread.id)}
                        split={splitFor(row)}
                      />
                    ))}
                  </ul>
                </section>
              )}
            </div>
            {!!data.log.length && (
              <details className="ws-log">
                <summary>
                  Changes made by Workstreams ({data.log.length})
                  {data.mode === "auto"
                    ? " · organizes after each analysis"
                    : " · suggest only"}
                </summary>
                <ul>
                  {[...data.log].reverse().map((e) => (
                    <li key={e.id} className={e.undone ? "ws-undone" : ""}>
                      <span className="ws-muted">
                        {new Date(e.at).toLocaleString()} ·{" "}
                        {e.result === "planned" ? "planned" : e.result}
                      </span>{" "}
                      {e.action.kind === "split"
                        ? `Split side quest ${e.action.drift.from} → ${e.action.drift.to}`
                        : e.action.kind === "retitle"
                          ? `Renamed to “${e.action.title}”`
                          : e.action.kind === "removeSection"
                            ? `Removed empty section ${e.action.section}`
                            : `Moved to ${e.action.section}`}
                      {e.detail && (
                        <span className="ws-muted"> — {e.detail}</span>
                      )}
                      {e.result === "done" && !e.undone && e.undo && (
                        <button onClick={() => void call("undo", { id: e.id })}>
                          Undo
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {!!data.analysis?.warnings.length && (
              <details className="ws-warnings">
                <summary>
                  Incomplete analysis ({data.analysis.warnings.length})
                </summary>
                <ul>
                  {data.analysis.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
            <footer className="ws-muted">
              Groups, titles, and recaps are inferred by GPT-4.1 mini via AI
              Gateway from each thread’s requests and last response.
              {stats &&
                ` Last run: ${stats.seconds}s, ${stats.calls} calls, ${(stats.inputTokens + stats.outputTokens).toLocaleString()} tokens, $${stats.cost.toFixed(3)}.`}
              {!!stats?.summaryCalls &&
                ` Summaries (included above): ${stats.summaryCalls} calls, ${stats.summarySeconds}s, $${stats.summaryCost.toFixed(4)}.`}
            </footer>
          </>
        )}
      </div>
    </main>
  );
}
export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "sidebar",
    title: "Workstreams",
    description:
      "Threads grouped by workstream, with work state, a Needs-you band, and collapsible groups.",
    component: WorkstreamsThreadList,
  });
  app.slots.navPanel({
    id: "home",
    title: "Workstreams",
    icon: "Layers",
    path: "home",
    component: WorkstreamsPage,
  });
});
