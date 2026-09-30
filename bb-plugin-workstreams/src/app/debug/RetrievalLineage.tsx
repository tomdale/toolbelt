import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { RetrievalSnapshot } from "../../domain/understanding-debug.ts";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

/** Recorded production retrieval, never a recomputation against newer memory. */
export function RetrievalLineage({
  rpc,
  traceId,
  close,
}: {
  rpc: Rpc;
  traceId: string;
  close: () => void;
}) {
  const navigate = useBbNavigate();
  const [snapshots, setSnapshots] = useState<RetrievalSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setSnapshots(null);
    setError(null);
    rpc.call("understandingRetrievals", { traceId, limit: 10 }).then(
      (result) => {
        if (live) setSnapshots(result.retrievals);
      },
      (cause) => {
        if (live)
          setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, traceId, attempt]);
  const open = (kind: "accounts" | "evidence", id: string) => {
    navigate.toPluginPanel("home", {
      subPath: `understanding/${kind}/${encodeURIComponent(id)}`,
    });
    close();
  };
  return (
    <section
      aria-label="Understanding used by this decision"
      className="mt-4 rounded-md border border-border p-3"
    >
      <h4 className="text-xs font-semibold">
        Understanding used by this decision
      </h4>
      <p className="mt-1 text-xs text-muted-foreground">
        A snapshot of retrieval at call time. Exploring current memory may
        return different evidence.
      </p>
      {error ? (
        <div role="alert" className="mt-2 text-xs text-destructive">
          {error}{" "}
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="underline"
          >
            Retry retrieval history
          </button>
        </div>
      ) : snapshots === null ? (
        <p role="status" className="mt-2 text-xs">
          Loading retrieval history…
        </p>
      ) : !snapshots.length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No retained retrieval snapshot for this call. It may predate
          understanding diagnostics or have expired.
        </p>
      ) : (
        snapshots.map((snapshot) => (
          <div
            key={snapshot.id}
            className="mt-3 border-t border-border pt-2 text-xs"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <span>
                {snapshot.consumer} · {new Date(snapshot.at).toLocaleString()}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {snapshot.report.usedChars.toLocaleString()} /{" "}
                {snapshot.report.budget.toLocaleString()} characters
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words">
              Query: {snapshot.report.query}
            </p>
            <p className="mt-1 text-muted-foreground">
              Terms:{" "}
              {snapshot.report.terms.join(", ") || "No discriminating terms"}
            </p>
            <ul className="mt-2 space-y-1" aria-label="Retrieved memory">
              {snapshot.report.candidates
                .filter((c) => c.disposition === "included")
                .map((c) => (
                  <li key={`${c.kind}:${c.id}`}>
                    <button
                      type="button"
                      onClick={() =>
                        open(
                          c.kind === "account" ? "accounts" : "evidence",
                          c.id,
                        )
                      }
                      className="text-left underline decoration-muted-foreground underline-offset-2 focus-visible:outline focus-visible:outline-2"
                    >
                      {c.kind === "account" ? "Account" : "Evidence"}: {c.title}
                    </button>
                    <span className="ml-2 text-muted-foreground">
                      score {c.score} · {c.matchedTerms.join(", ")}
                    </span>
                  </li>
                ))}
            </ul>
            <details className="mt-2">
              <summary className="cursor-pointer">
                Exact supplied context
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px]">
                {snapshot.report.context ||
                  "No understanding context supplied."}
              </pre>
            </details>
            <details className="mt-2">
              <summary className="cursor-pointer">Retrieval exclusions</summary>
              <ul className="mt-1 space-y-1">
                {snapshot.report.candidates
                  .filter((c) => c.disposition !== "included")
                  .map((c) => (
                    <li key={`${c.kind}:${c.id}`}>
                      {c.title} · {c.disposition} · score {c.score}
                    </li>
                  ))}
              </ul>
            </details>
          </div>
        ))
      )}
    </section>
  );
}
