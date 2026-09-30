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
  useEffect(() => { if (scope.kind === "thread") void rpc.call("recap_get", { threadId: scope.threadId }).then((value) => setRecap(value.recap)); }, [rpc, scope]);
  useRealtime("changed", () => { if (scope.kind === "thread") void rpc.call("recap_get", { threadId: scope.threadId }).then((value) => setRecap(value.recap)); });
  if (scope.kind !== "thread" || continuing || !recap) return null;
  const ledger = parseRecapLedger(recap.summary);
  return <section className="ws-recap-card rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs">
    {ledger ? <>
      {ledger.goal ? <h3 className="font-medium">{ledger.goal}</h3> : null}
      {ledger.latest.length ? <p className="mt-1"><strong>Latest:</strong> {ledger.latest.join(" ")}</p> : null}
      {ledger.open.length ? <p className="mt-1"><strong>Open:</strong> {ledger.open.join(" ")}</p> : null}
      {ledger.done.length ? <p className="mt-1 opacity-70"><strong>Done:</strong> {ledger.done.join(" ")}</p> : null}
    </> : <p>{recap.summary}</p>}
    {archive.visible ? <button type="button" className="ws-archive-button mt-2" disabled={archive.busy} onClick={() => void archive.decide("archive")}>Archive</button> : null}
    {archive.error ? <span role="alert" className="ws-banner-error ml-2">{archive.error}</span> : null}
  </section>;
}
