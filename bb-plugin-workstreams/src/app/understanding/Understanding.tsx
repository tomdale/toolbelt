import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Markdown,
  useBbNavigate,
  useRealtime,
  type useRpc,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type {
  LearningRun,
  Notebook,
  NotebookVersion,
} from "../../domain/notebooks.ts";
import "./understanding.css";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;
type View = "brief" | "notebooks" | "runs";
type NotebookOverview = {
  brief: { text: string; updatedAt: number };
  notebooks: Notebook[];
  runs: LearningRun[];
  running: boolean;
  totalNotebooks: number;
};
const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
const date = (at: number | null) =>
  at === null ? "In progress" : new Date(at).toLocaleString();
const money = (amount: number) => `$${amount.toFixed(4)}`;

export function Understanding({ rpc }: { rpc: Rpc; subPath?: string }) {
  const navigate = useBbNavigate();
  const [view, setView] = useState<View>("brief");
  const [overview, setOverview] = useState<NotebookOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    notebook: Notebook | null;
    versions: NotebookVersion[];
  } | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [history, setHistory] = useState<NotebookVersion[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [threadId, setThreadId] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<LearningRun | null>(null);
  const [runUpdates, setRunUpdates] = useState<Record<string, LearningRun>>({});
  const overviewGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;

  const refresh = useCallback(async () => {
    const generation = ++overviewGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call("notebookOverview", {
        ...(query.trim() ? { query: query.trim() } : {}),
        offset: 0,
      });
      if (generation === overviewGeneration.current) setOverview(result);
    } catch (cause) {
      if (generation === overviewGeneration.current)
        setError(errorMessage(cause));
    } finally {
      if (generation === overviewGeneration.current) setLoading(false);
    }
  }, [rpc, query]);

  useEffect(() => {
    void refresh();
    return () => {
      overviewGeneration.current++;
    };
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const generation = ++detailGeneration.current;
    setDetail(null);
    setDetailError(null);
    rpc.call("notebook", { threadId: selectedId }).then(
      (result) => {
        if (generation === detailGeneration.current) setDetail(result);
      },
      (cause: unknown) => {
        if (generation === detailGeneration.current)
          setDetailError(errorMessage(cause));
      },
    );
    return () => {
      detailGeneration.current++;
    };
  }, [rpc, selectedId]);

  const updateRun = useCallback(
    async (id: string) => {
      try {
        const result = await rpc.call("notebookRun", { id });
        if (result.run) {
          setRunUpdates((current) => ({ ...current, [id]: result.run! }));
          setActiveRun((current) =>
            current?.id === id ? result.run : current,
          );
        }
      } catch (cause) {
        setActionError(errorMessage(cause));
      }
    },
    [rpc],
  );

  const runningIds = (overview?.runs ?? [])
    .filter((run) => (runUpdates[run.id] ?? run).status === "running")
    .map((run) => run.id);
  if (activeRun?.status === "running" && !runningIds.includes(activeRun.id))
    runningIds.push(activeRun.id);
  const runningKey = runningIds.join("|");
  useEffect(() => {
    if (view !== "runs" || !runningIds.length) return;
    const timer = window.setInterval(
      () => runningIds.forEach((id) => void updateRun(id)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [view, runningKey, updateRun]);

  useRealtime("changed", () => {
    void refresh();
    if (selectedId) {
      const id = selectedId;
      const generation = ++detailGeneration.current;
      rpc
        .call("notebook", { threadId: id })
        .then((result) => {
          if (
            selectedRef.current === id &&
            generation === detailGeneration.current
          )
            setDetail(result);
        })
        .catch(() => {});
    }
    if (activeRun?.status === "running") void updateRun(activeRun.id);
  });

  const learn = async (id: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await rpc.call("notebookLearn", { threadId: id });
      setSelectedId(id);
      setView("notebooks");
      await refresh();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt) return;
    setBusy(true);
    setActionError(null);
    try {
      const run = await rpc.call("notebookAsk", { question: prompt });
      setActiveRun(run);
      setView("runs");
      setQuestion("");
      await refresh();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const openNotebook = (id: string) => {
    setSelectedId(id);
    setView("notebooks");
  };

  const loadBriefHistory = async () => {
    setHistoryOpen((open) => !open);
    if (history) return;
    try {
      const result = await rpc.call("notebookBriefVersions", null);
      setHistory(result.versions);
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  };

  const cancel = async (run: LearningRun) => {
    try {
      await rpc.call("notebookCancel", { id: run.id });
      await updateRun(run.id);
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  };

  const notebooks = overview?.notebooks ?? [];
  const runs = overview?.runs ?? [];
  const brief = overview?.brief;
  const chosen = detail?.notebook;

  return (
    <section className="understanding" aria-label="Notebook explorer">
      <header className="understanding__header">
        <div>
          <p className="understanding__eyebrow">Workstreams / Understanding</p>
          <h2>Notebook explorer</h2>
          <p className="understanding__intro">
            A shared, evolving understanding in the learner’s own words.
          </p>
        </div>
        <button
          type="button"
          className="understanding__button"
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </header>

      <form className="understanding__ask" onSubmit={ask}>
        <label htmlFor="understanding-question">Ask the learner</label>
        <p>
          Read-only question · uses a paid model call · does not change
          notebooks
        </p>
        <div className="understanding__ask-row">
          <input
            id="understanding-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What have I been exploring lately?"
          />
          <button
            className="understanding__button understanding__button--primary"
            type="submit"
            disabled={busy || !question.trim()}
          >
            {busy ? "Working…" : "Ask"}
          </button>
        </div>
      </form>

      <nav className="understanding__nav" aria-label="Notebook views">
        {(
          [
            ["brief", "Brief"],
            ["notebooks", "Notebooks"],
            ["runs", "Learning runs"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={view === id ? "page" : undefined}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {error ? (
        <div className="understanding__error" role="alert">
          {error}{" "}
          <button type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : null}
      {actionError ? (
        <div className="understanding__error" role="alert">
          {actionError}
          <button type="button" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <article className="understanding__brief">
        <div className="understanding__section-heading">
          <div>
            <p className="understanding__eyebrow">Shared understanding</p>
            <h3>Brief</h3>
          </div>
          <button
            type="button"
            className="understanding__text-button"
            onClick={() => void loadBriefHistory()}
          >
            {historyOpen ? "Hide history" : "History"}
          </button>
        </div>
        {loading && !brief ? (
          <p role="status">Loading brief…</p>
        ) : brief?.text ? (
          <Markdown content={brief.text} className="understanding__markdown" />
        ) : (
          <div className="understanding__empty">
            <p>The shared brief is empty for now.</p>
            <p>
              It grows as the learner reads conversations and writes a concise
              summary. You can ask a read-only question above, or learn from a
              thread below.
            </p>
          </div>
        )}
        {brief ? (
          <p className="understanding__updated">
            Updated {date(brief.updatedAt)}
          </p>
        ) : null}
        {historyOpen ? (
          <div className="understanding__history" aria-label="Brief history">
            {history === null ? (
              <p>Loading history…</p>
            ) : history.length ? (
              history.map((version) => (
                <details key={version.id}>
                  <summary>
                    {date(version.at)}
                    {version.runId ? ` · run ${version.runId}` : ""}
                  </summary>
                  <Markdown
                    content={version.text}
                    className="understanding__markdown"
                  />
                </details>
              ))
            ) : (
              <p>No earlier brief versions.</p>
            )}
          </div>
        ) : null}
      </article>

      {view === "brief" ? (
        <section className="understanding__below">
          <h3>Explore notebooks</h3>
          <p>
            Each notebook is a plain-language understanding of one conversation.
          </p>
          <button
            className="understanding__button"
            type="button"
            onClick={() => setView("notebooks")}
          >
            Browse notebooks ({overview?.totalNotebooks ?? 0})
          </button>
        </section>
      ) : null}

      {view === "notebooks" ? (
        <section className="understanding__content" aria-label="Notebooks">
          <div className="understanding__section-heading">
            <div>
              <h3>Notebooks</h3>
              <p>{overview?.totalNotebooks ?? 0} conversations learned</p>
            </div>
            <label className="understanding__search">
              <span className="understanding__sr-only">Search notebooks</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search notebooks"
              />
            </label>
          </div>
          <div className="understanding__columns">
            <div className="understanding__list" aria-label="Notebook list">
              {loading && !overview ? (
                <p role="status">Loading notebooks…</p>
              ) : null}
              {!loading && notebooks.length === 0 ? (
                <p className="understanding__empty">
                  No notebooks found. Automatic learning can be enabled in
                  plugin settings, or enter a thread ID below to learn one now.
                </p>
              ) : null}
              {notebooks.map((notebook) => (
                <button
                  type="button"
                  key={notebook.threadId}
                  aria-current={
                    selectedId === notebook.threadId ? "true" : undefined
                  }
                  onClick={() => openNotebook(notebook.threadId)}
                >
                  <strong>{notebook.title || "Untitled conversation"}</strong>
                  <span>
                    {notebook.text.slice(0, 150) ||
                      notebook.error ||
                      "No notebook text yet."}
                  </span>
                  <small>Updated {date(notebook.updatedAt)}</small>
                </button>
              ))}
              <form
                className="understanding__learn-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (threadId.trim()) void learn(threadId.trim());
                }}
              >
                <label htmlFor="understanding-thread-id">
                  Learn from a thread
                </label>
                <p>
                  Paid model call · writes this thread’s notebook and may update
                  the shared brief.
                </p>
                <div>
                  <input
                    id="understanding-thread-id"
                    aria-label="Thread ID"
                    value={threadId}
                    onChange={(event) => setThreadId(event.target.value)}
                    placeholder="Thread ID"
                  />
                  <button
                    className="understanding__button"
                    disabled={busy || !threadId.trim()}
                  >
                    Learn
                  </button>
                </div>
              </form>
            </div>
            <div className="understanding__detail">
              {detailError ? <p role="alert">{detailError}</p> : null}
              {selectedId && !detail ? (
                <p role="status">Loading notebook…</p>
              ) : null}
              {chosen ? (
                <>
                  <div className="understanding__section-heading">
                    <div>
                      <h3>{chosen.title || "Untitled conversation"}</h3>
                      <p>Notebook · updated {date(chosen.updatedAt)}</p>
                    </div>
                    <button
                      type="button"
                      className="understanding__text-button"
                      onClick={() => void learn(chosen.threadId)}
                      disabled={busy}
                    >
                      Learn from thread
                    </button>
                  </div>
                  <p className="understanding__source">
                    Source conversation:{" "}
                    <button
                      type="button"
                      onClick={() => navigate.toThread(chosen.threadId)}
                    >
                      Open conversation
                    </button>
                  </p>
                  {chosen.error ? (
                    <p className="understanding__error">{chosen.error}</p>
                  ) : null}
                  <Markdown
                    content={chosen.text || "No notebook text yet."}
                    className="understanding__markdown"
                  />
                  {detail?.versions.length ? (
                    <details className="understanding__history">
                      <summary>
                        Notebook history ({detail.versions.length})
                      </summary>
                      {detail.versions.map((version) => (
                        <details key={version.id}>
                          <summary>
                            {date(version.at)}
                            {version.runId ? ` · run ${version.runId}` : ""}
                          </summary>
                          <Markdown
                            content={version.text}
                            className="understanding__markdown"
                          />
                        </details>
                      ))}
                    </details>
                  ) : null}
                </>
              ) : selectedId && !detailError ? null : (
                <div className="understanding__empty">
                  <p>Select a notebook to read it.</p>
                  <p>
                    To start from a conversation without a notebook, enter its
                    thread ID.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {view === "runs" ? (
        <section className="understanding__content" aria-label="Learning runs">
          <div className="understanding__section-heading">
            <div>
              <h3>Learning runs</h3>
              <p>What the learner did and what it reported.</p>
            </div>
          </div>
          {activeRun ? (
            <RunCard
              run={activeRun}
              onCancel={() => void cancel(activeRun)}
              onSource={(id) => openNotebook(id)}
            />
          ) : null}
          {runs
            .filter((run) => run.id !== activeRun?.id)
            .map((original) => {
              const run = runUpdates[original.id] ?? original;
              return (
                <RunCard
                  key={run.id}
                  run={run}
                  onCancel={() => void cancel(run)}
                  onSource={(id) => openNotebook(id)}
                />
              );
            })}
          {!activeRun && runs.length === 0 ? (
            <p className="understanding__empty">
              No learning runs yet. Ask a question or learn from a thread to
              start one.
            </p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function RunCard({
  run,
  onCancel,
  onSource,
}: {
  run: LearningRun;
  onCancel: () => void;
  onSource: (id: string) => void;
}) {
  return (
    <article className="understanding__run">
      <header>
        <div>
          <h4>
            {run.question ||
              (run.threadId ? "Learn from conversation" : "Learning run")}
          </h4>
          <p>
            {run.status} · started {date(run.startedAt)}
            {run.finishedAt ? ` · finished ${date(run.finishedAt)}` : ""}
          </p>
        </div>
        {run.status === "running" ? (
          <button
            type="button"
            className="understanding__button"
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : null}
      </header>
      {run.threadId ? (
        <p className="understanding__source">
          Conversation:{" "}
          <button type="button" onClick={() => onSource(run.threadId!)}>
            Open conversation
          </button>
        </p>
      ) : null}
      {run.summary ? (
        <Markdown content={run.summary} className="understanding__markdown" />
      ) : null}
      {run.error ? <p className="understanding__error">{run.error}</p> : null}
      {run.steps.length ? (
        <details className="understanding__steps">
          <summary>What the learner did ({run.steps.length} steps)</summary>
          {run.steps.map((step, index) => (
            <details key={`${index}-${step.at}`}>
              <summary>
                {step.tool} · {date(step.at)}
              </summary>
              <div className="understanding__step-body">
                <strong>Input</strong>
                <pre>{step.input}</pre>
                <strong>Output</strong>
                <pre>{step.output}</pre>
              </div>
            </details>
          ))}
        </details>
      ) : null}
      <p className="understanding__usage">
        {run.model} · {run.usage.input.toLocaleString()} input /{" "}
        {run.usage.output.toLocaleString()} output tokens ·{" "}
        {money(run.usage.cost)}
      </p>
    </article>
  );
}
