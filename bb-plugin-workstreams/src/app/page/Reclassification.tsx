import { useState } from "react";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type {
  RpcContract,
  ReclassificationPlan,
} from "../../server/contract.ts";
import { secondaryButton, primaryButton } from "./controls.ts";

/** Explicit preview/apply keeps catalog repairs separate from editing topics. */
export function Reclassification({
  rpc,
  threadIds,
  onApplied,
}: {
  rpc: ReturnType<typeof useRpc<RpcContract>>;
  threadIds: string[];
  onApplied: () => void;
}) {
  const [plan, setPlan] = useState<ReclassificationPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (apply: boolean) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (apply && plan) {
        const result = await rpc.call("reclassificationApply", {
          planId: plan.id,
        });
        setMessage(
          `${result.changed} topics changed; ${result.skipped} skipped. Manual choices and newer evidence are preserved.`,
        );
        setPlan(null);
        onApplied();
      } else {
        const next = await rpc.call("reclassificationPreview", { threadIds });
        setPlan(next);
        setMessage(
          `${next.rows.filter((row) => !row.error).length} topic proposals ready for review; ${next.excludedManual} manual choices excluded.`,
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="rounded-xl border border-border p-4"
      aria-label="Topic repair"
    >
      <h2 className="text-sm font-semibold">Review automatic topics</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        After editing the catalog, preview assignments before applying repairs.
        Previewing makes model calls but changes no topics or titles.
      </p>
      <button
        type="button"
        className={`${secondaryButton} mt-3`}
        disabled={busy || !threadIds.length || threadIds.length > 100}
        onClick={() => void run(false)}
      >
        {busy ? "Working…" : "Preview topic repairs"}
      </button>
      {threadIds.length > 100 ? (
        <p className="mt-2 text-xs">
          This view previews up to 100 roots. For a larger set, preview
          individual roots with{" "}
          <code>bb workstreams topics preview &lt;thread-id&gt;</code>.
        </p>
      ) : null}
      {plan ? (
        <div className="mt-3">
          {plan.excludedManual ? (
            <p className="mb-2 text-xs">
              {plan.excludedManual} manual choices excluded
            </p>
          ) : null}
          <ul className="space-y-1 text-xs">
            {plan.rows.map((row) => (
              <li key={row.threadId}>
                {row.title}: {row.from ?? "Unfiled"} → {row.to ?? "Unfiled"}
                {row.error ? ` — ${row.error}` : ""}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={`${primaryButton} mt-3`}
            disabled={busy || plan.rows.every((row) => row.error)}
            onClick={() => void run(true)}
          >
            Apply topic repairs
          </button>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="mt-2 text-xs">
        {message ?? ""}
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
