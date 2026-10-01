import { useCallback, useEffect, useState } from "react";
import {
  Markdown,
  useRealtime,
  useRpc,
  useBbNavigate,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { QuestionHistory } from "../../server/questions/history.ts";

export function QuestionHistoryButton({
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      className="rounded px-2 py-1 text-xs hover:bg-secondary"
      title="View saved questions and answers"
      aria-label="Question history"
      onClick={() =>
        navigate.openThreadPanel({
          actionId: "question-history",
          title: "Question history",
          params: null,
        })
      }
    >
      {isCompactViewport ? "Q&A" : "Question history"}
    </button>
  );
}

export function QuestionHistoryPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<RpcContract>();
  const [rows, setRows] = useState<QuestionHistory[] | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    try {
      const rows = await rpc.call("question_history", { threadId });
      setRows(rows);
      setError(false);
    } catch {
      setError(true);
    }
  }, [rpc, threadId]);
  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);
  useRealtime("changed", () => void load());
  return (
    <div className="space-y-3 p-4 text-foreground">
      <h2 className="text-sm font-semibold">Question history</h2>
      <p className="text-xs text-muted-foreground">
        Saved questions and answers for this thread, including retained older
        answers. Latest 100 records; older transcript recovery scans the latest
        200 input and tool events.
      </p>
      {error ? (
        <p role="alert">
          Could not load question history.{" "}
          <button onClick={() => void load()}>Retry</button>
        </p>
      ) : null}
      {!rows && !error ? <p role="status">Loading questions…</p> : null}
      {rows?.length === 0 ? <p>No saved questions yet</p> : null}
      {rows?.map((row) => (
        <details
          key={row.id}
          open
          className="rounded-lg border border-border p-3"
        >
          <summary className="cursor-pointer text-xs font-medium">
            {row.payload.questions.map((q) => q.shortLabel).join(" · ")} —{" "}
            {row.status === "unknown" ? "Answer unavailable" : row.status}
            {row.at ? ` · ${new Date(row.at).toLocaleString()}` : ""}
          </summary>
          <div className="mt-3 space-y-4">
            {row.payload.questions.map((q) => (
              <section key={q.id} className="space-y-2 text-sm">
                <Markdown content={q.prompt} />
                {q.options.length ? (
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {q.options.map((o) => (
                      <li key={o.value}>
                        <strong>{o.label}</strong> — {o.description}
                        {o.preview ? (
                          <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded border border-border p-2">
                            {o.preview}
                          </pre>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="rounded border border-amber-400/50 bg-amber-50/20 p-2 dark:bg-transparent">
                  <strong className="text-xs">Your answer</strong>
                  <p className="whitespace-pre-wrap text-sm">
                    {row.result?.answers[q.prompt] ??
                      (row.status === "dismissed"
                        ? "Dismissed without an answer or approval"
                        : row.status === "pending"
                          ? "Awaiting your answer"
                          : "No answer was retained")}
                  </p>
                </div>
              </section>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
