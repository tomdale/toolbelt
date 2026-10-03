/**
 * The Organize pane: one reviewed organizing pass (SPEC §8). A preview is a
 * whole-proposal decision: Apply performs it as one journaled batch, Discard
 * drops it, and Regenerate replaces it. Nothing moves before Apply.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRealtime, type useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { BootstrapState } from "../../server/bootstrap.ts";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { InspectButton } from "../debug/InspectButton.tsx";
import { ghostButton, primaryButton, secondaryButton } from "./controls.ts";
import { buildReview } from "./organize-review.ts";
import { ProposalReview, plural } from "./OrganizeReview.tsx";
import { useThreadTotals, type ThreadTotals } from "./thread-totals.ts";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;
type Command = Parameters<Rpc["call"]>[1];

export function Organize({
  rpc,
  onShowActivity,
  children,
}: {
  rpc: Rpc;
  bootstrapped?: boolean;
  /** Opens the Activity log, where an applied pass can be undone. */
  onShowActivity?: () => void;
  /** Shown only while no pass is running or awaiting review. */
  children?: ReactNode;
}) {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requested = useRef(0);
  const settled = useRef(0);
  const command = useRef(0);
  const errorOwner = useRef<"read" | "command" | null>(null);
  const totals = useThreadTotals();
  const read = useCallback(async () => {
    const generation = ++requested.current;
    try {
      const result = await rpc.call("bootstrap", { action: "get" });
      if (generation < settled.current) return;
      settled.current = generation;
      setState(result.state as BootstrapState | null);
      if (errorOwner.current === "read") {
        errorOwner.current = null;
        setError(null);
      }
    } catch (cause) {
      if (generation < settled.current) return;
      settled.current = generation;
      if (errorOwner.current !== "command") {
        errorOwner.current = "read";
        setError(String(cause));
      }
    } finally {
      setLoaded(true);
    }
  }, [rpc]);
  const send = async (input: Command) => {
    const owner = ++command.current;
    const generation = ++requested.current;
    settled.current = generation;
    errorOwner.current = "command";
    setError(null);
    setBusy(true);
    try {
      const result = await rpc.call("bootstrap", input as never);
      if (command.current !== owner) return;
      errorOwner.current = null;
      setError(null);
      if (generation >= settled.current) {
        settled.current = generation;
        setState(result.state as BootstrapState | null);
      }
    } catch (cause) {
      if (command.current === owner) {
        errorOwner.current = "command";
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (command.current === owner) {
        setBusy(false);
        void read();
      }
    }
  };
  useEffect(() => {
    void read();
  }, [read]);
  useRealtime("changed", () => void read());
  const working = state?.status === "proposing" || state?.status === "applying";
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void read(), 1000);
    return () => clearInterval(timer);
  }, [working, read]);
  const preview = state?.status === "preview" ? state.preview : null;
  const review = useMemo(
    () =>
      state && preview ? buildReview(state, preview, totals.childrenOf) : null,
    [state, preview, totals],
  );
  if (!loaded) return null;
  const inspect = state?.traceIds?.length ? (
    <InspectButton
      target={{ traceIds: state.traceIds }}
      title="Organizing pass"
      label="Inspect organizing pass"
      className="text-muted-foreground"
    />
  ) : null;
  const commandError = error ? (
    <p
      role="alert"
      className="flex items-start gap-1.5 text-xs text-destructive"
    >
      <Icon name="CircleX" aria-hidden className="mt-px size-3.5 shrink-0" />
      {error}
    </p>
  ) : null;
  return (
    <section aria-label="Organize" className="flex flex-col gap-6 text-sm">
      {state && review ? (
        <ProposalReview
          review={review}
          busy={busy}
          inspect={inspect}
          alert={commandError}
          onApply={() =>
            void send({
              action: "apply",
              runId: state.startedAt,
              overrides: [],
            })
          }
          onDiscard={() => void send({ action: "cancel" })}
          onRegenerate={() => void send({ action: "start" })}
        />
      ) : (
        <>
          <StatusPanel
            state={state}
            busy={busy}
            totals={totals}
            inspect={inspect}
            alert={commandError}
            onStart={() => void send({ action: "start" })}
            onCancel={() => void send({ action: "cancel" })}
            onShowActivity={onShowActivity}
          />
          {!working ? children : null}
        </>
      )}
    </section>
  );
}

/** The pane before a preview exists: start, progress, failure or result. */
function StatusPanel({
  state,
  busy,
  totals,
  inspect,
  alert,
  onStart,
  onCancel,
  onShowActivity,
}: {
  state: BootstrapState | null;
  busy: boolean;
  totals: ThreadTotals;
  inspect: ReactNode;
  alert: ReactNode;
  onStart: () => void;
  onCancel: () => void;
  onShowActivity?: () => void;
}) {
  const status = state?.status ?? "idle";
  const progress = state?.progress;
  const heading =
    status === "proposing"
      ? "Preparing a proposal"
      : status === "applying"
        ? "Applying organization"
        : status === "applied"
          ? "Organization applied"
          : status === "failed"
            ? "Organizing stopped"
            : "Organize workstreams";
  const detail =
    status === "proposing"
      ? progress?.stage === "classifying"
        ? `Classifying tasks ${progress.completed} of ${progress.total}`
        : progress?.stage === "regrouping"
          ? "Grouping tasks into workstreams…"
          : "Reading open threads…"
      : status === "applying"
        ? "Moving tasks and updating workstreams…"
        : status === "applied"
          ? "Undo the whole pass from Activity if anything looks wrong."
          : status === "failed"
            ? null
            : totals.ready && totals.tasks
              ? `Proposes one grouping for your ${plural(totals.tasks, "open task")}${totals.childThreads ? `; their ${plural(totals.childThreads, "child thread")} stay with them` : ""}. Nothing moves until you review and apply the whole proposal.`
              : "Proposes one grouping for your open tasks. Nothing moves until you review and apply the whole proposal.";
  const working = status === "proposing" || status === "applying";
  const determinate =
    status === "proposing" &&
    progress?.stage === "classifying" &&
    progress.total > 0;
  return (
    <div
      aria-busy={working || undefined}
      className={cn(
        "rounded-xl border px-4 py-3.5",
        status === "failed" ? "border-destructive/30" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="flex items-center gap-1.5 text-[13px] font-medium">
            {status === "applied" ? (
              <Icon
                name="Check"
                aria-hidden
                className="size-3.5 text-emerald-600 dark:text-emerald-400"
              />
            ) : null}
            {heading}
            {inspect}
          </h2>
          {detail ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {detail}
            </p>
          ) : null}
          {status === "proposing" && progress?.stage === "classifying" ? (
            <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground/80">
              {progress.cached} already classified
              {progress.unresolved
                ? ` · ${progress.unresolved} unresolved`
                : ""}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status === "proposing" ? (
            <button type="button" className={ghostButton} onClick={onCancel}>
              Cancel
            </button>
          ) : null}
          {status === "failed" ? (
            <button
              type="button"
              className={ghostButton}
              disabled={busy}
              onClick={onCancel}
            >
              Dismiss
            </button>
          ) : null}
          {status === "applied" && onShowActivity ? (
            <button
              type="button"
              className={ghostButton}
              onClick={onShowActivity}
            >
              View in Activity
            </button>
          ) : null}
          {!working ? (
            <button
              type="button"
              className={status === "applied" ? secondaryButton : primaryButton}
              disabled={busy}
              onClick={onStart}
            >
              {status === "failed"
                ? "Start over"
                : status === "applied"
                  ? "Organize again…"
                  : "Organize…"}
            </button>
          ) : null}
        </div>
      </div>
      {working ? (
        <>
          <ProgressBar
            value={determinate ? progress!.completed / progress!.total : null}
            label={
              determinate
                ? `Classifying tasks ${progress!.completed} of ${progress!.total}`
                : heading
            }
          />
          <span role="status" className="sr-only">
            {detail}
          </span>
        </>
      ) : null}
      {status === "failed" && state?.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
      {status === "applied" && state?.error ? (
        <p
          role="status"
          className="mt-2 rounded-md bg-state-hover/60 px-2.5 py-1.5 text-xs text-muted-foreground"
        >
          {state.error}
        </p>
      ) : null}
      {alert ? <div className="mt-2">{alert}</div> : null}
    </div>
  );
}

function ProgressBar({
  value,
  label,
}: {
  value: number | null;
  label: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(value * 100)}
      className="relative mt-3 h-1 overflow-hidden rounded-full bg-state-hover"
    >
      {value === null ? (
        <span className="ws-progress-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-primary/70" />
      ) : (
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${Math.max(2, value * 100)}%` }}
        />
      )}
    </div>
  );
}
