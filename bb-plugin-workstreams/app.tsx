import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { groupThreads, type Row, type Snapshot } from "./model";
import { Button } from "./components/ui/button";
import "./app.css";

const FRESHNESS: Record<Row["freshness"], string | null> = {
  current: null,
  changed: "Updated since analysis",
  failed: "Not refreshed",
  new: "Not analyzed",
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
const anchor = (name: string) =>
  `ws-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

function ThreadRow({ row, open }: { row: Row; open: () => void }) {
  const { thread, title, recap, needsYou, freshness } = row;
  const runtime = RUNTIME[thread.status];
  const tag = FRESHNESS[freshness];
  return (
    <li>
      <button className="ws-row" title={thread.title} onClick={open}>
        <span className="ws-row-top">
          <strong>{title}</strong>
          <span className="ws-when">{when(thread.updatedAt)}</span>
        </span>
        {recap && <span className="ws-recap">{recap}</span>}
        {(needsYou || runtime || tag) && (
          <span className="ws-tags">
            {needsYou && <span className="ws-tag ws-tag-you">Needs you</span>}
            {runtime && (
              <span className={`ws-tag ws-runtime-${thread.status}`}>
                {runtime}
              </span>
            )}
            {tag && <span className="ws-tag ws-tag-muted">{tag}</span>}
          </span>
        )}
      </button>
    </li>
  );
}

function WorkstreamsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [data, setData] = useState<Snapshot | null>(null);
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
  const call = async (method: "analyze" | "cancel") => {
    setBusy(true);
    setError("");
    try {
      await rpc.call(method);
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
              `${name} ${r.title} ${r.thread.title} ${r.thread.project} ${r.recap ?? ""}`
                .toLowerCase()
                .includes(q),
          ),
        ] as const,
    )
    .filter(([, rows]) => rows.length);
  const stats = data?.analysis?.stats;
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
                {groups.map(([name, rows]) => (
                  <button
                    key={name}
                    className="ws-chip"
                    onClick={() =>
                      document
                        .getElementById(anchor(name))
                        ?.scrollIntoView({ block: "start" })
                    }
                  >
                    {name} <span>{rows.length}</span>
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
            <div className="ws-groups">
              {groups.map(([name, rows]) => (
                <section
                  className="ws-group"
                  key={name}
                  id={anchor(name)}
                  aria-label={name}
                >
                  <h2>
                    {name} <span>{rows.length}</span>
                  </h2>
                  <ul>
                    {rows.map((row) => (
                      <ThreadRow
                        key={row.thread.id}
                        row={row}
                        open={() => navigate.toThread(row.thread.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
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
              Gateway from each thread’s requests and last response. Threads are
              never changed.
              {stats &&
                ` Last run: ${stats.seconds}s, ${stats.calls} calls, ${(stats.inputTokens + stats.outputTokens).toLocaleString()} tokens, $${stats.cost.toFixed(3)}.`}
            </footer>
          </>
        )}
      </div>
    </main>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "home",
    title: "Workstreams",
    icon: "Layers",
    path: "home",
    component: WorkstreamsPage,
  });
});
