import { useComposerView, useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import type { RpcContract } from "../../server/contract.ts";
import { parseRecapLedger } from "../../domain/recap.ts";
import { useArchiveSuggestion } from "../archive/useArchiveSuggestion.ts";

export function RecapCard() {
  const { scope, draft, run } = useComposerView();
  const rpc = useRpc<RpcContract>();
  const [recap, setRecap] = useState<{ summary: string } | null>(null);
  const continuing = !draft.isEmpty || draft.attachmentCount > 0 || run.isRunning || run.isSubmitting;
  const archive = useArchiveSuggestion(scope.kind === "thread" ? scope.threadId : null, continuing);
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  useEffect(() => { if (threadId) void rpc.call("recap_get", { threadId }).then((value) => setRecap(value.recap)); else setRecap(null); }, [rpc, threadId]);
  useRealtime("changed", () => { if (threadId) void rpc.call("recap_get", { threadId }).then((value) => setRecap(value.recap)); });
  if (scope.kind !== "thread" || continuing || !recap) return null;
  const ledger = parseRecapLedger(recap.summary);
  return <section className="ws-recap-card">
    <header className="ws-recap-header">
      {ledger?.goal ? <h3>{ledger.goal}</h3> : <h3>Recap</h3>}
      {archive.visible ? <button type="button" className="ws-archive-button" disabled={archive.busy} onClick={() => void archive.decide("archive")}>Archive</button> : null}
    </header>
    <div className="ws-recap-body">{ledger ? <>
      {ledger.latest.length ? <p><strong>Latest:</strong> {ledger.latest.join(" ")}</p> : null}
      {ledger.open.length ? <p><strong>Open:</strong> {ledger.open.join(" ")}</p> : null}
      {ledger.done.length ? <p className="ws-recap-done"><strong>Done:</strong> {ledger.done.join(" ")}</p> : null}
    </> : <p>{recap.summary}</p>}</div>
    {archive.error ? <span role="alert" className="ws-banner-error">{archive.error}</span> : null}
  </section>;
}
