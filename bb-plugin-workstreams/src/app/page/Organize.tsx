/**
 * The Organize pane: live organization state and derived workstreams.
 * Workstreams are always derived automatically from active task identities.
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
import type { LiveOrganization, RpcContract } from "../../server/contract.ts";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { InspectButton } from "../debug/InspectButton.tsx";
import { ghostButton, primaryButton, secondaryButton } from "./controls.ts";
import { buildReview } from "./organize-review.ts";
import { ProposalReview, plural } from "./OrganizeReview.tsx";
import type { ReviewTask } from "./organize-review.ts";
import { useThreadTotals, type ThreadTotals } from "./thread-totals.ts";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

export function Organize({
  rpc,
  onShowActivity,
  renderTaskAction,
  children,
}: {
  rpc: Rpc;
  bootstrapped?: boolean;
  /** Opens the Activity log. */
  onShowActivity?: () => void;
  /** Optional slot for cross-surface identity correction control from Phase 3. */
  renderTaskAction?: (task: ReviewTask) => ReactNode;
  children?: ReactNode;
}) {
  const [state, setState] = useState<LiveOrganization | null>(null);
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
      const result = await rpc.call("organization", { action: "get" });
      if (generation < settled.current) return;
      settled.current = generation;
      setState(result.state);
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

  const send = async (action: "rebuild") => {
    const owner = ++command.current;
    const generation = ++requested.current;
    settled.current = generation;
    errorOwner.current = "command";
    setError(null);
    setBusy(true);
    try {
      const result = await rpc.call("organization", { action });
      if (command.current !== owner) return;
      errorOwner.current = null;
      setError(null);
      if (generation >= settled.current) {
        settled.current = generation;
        setState(result.state);
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

  const working =
    state?.status === "classifying" ||
    state?.status === "deriving" ||
    state?.status === "syncing";

  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void read(), 1000);
    return () => clearInterval(timer);
  }, [working, read]);

  const review = useMemo(
    () => (state ? buildReview(state, totals.childrenOf) : null),
    [state, totals],
  );

  if (!loaded) return null;

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
      {state && state.status === "idle" && review ? (
        <ProposalReview
          review={review}
          busy={busy}
          inspect={null}
          alert={commandError}
          renderTaskAction={renderTaskAction}
          onApply={() => void send("rebuild")}
          onDiscard={() => void read()}
          onRegenerate={() => void send("rebuild")}
        />
      ) : (
        <>
          <StatusPanel
            state={state}
            busy={busy}
            totals={totals}
            alert={commandError}
            onStart={() => void send("rebuild")}
            onCancel={() => void read()}
            onShowActivity={onShowActivity}
          />
          {!working ? children : null}
        </>
      )}
    </section>
  );
}

/** The pane during work or failure. */
function StatusPanel({
  state,
  busy,
  totals,
  alert,
  onStart,
  onCancel,
  onShowActivity,
}: {
  state: LiveOrganization | null;
  busy: boolean;
  totals: ThreadTotals;
  alert: ReactNode;
  onStart: () => void;
  onCancel: () => void;
  onShowActivity?: () => void;
}) {
  const status = state?.status ?? "idle";
  const progress = state?.progress;
  const heading =
    status === "classifying"
      ? "Classifying tasks"
      : status === "deriving" || status === "syncing"
        ? "Updating workstreams"
        : status === "failed"
          ? "Organizing stopped"
          : "Workstreams up to date";

  const detail =
    status === "classifying"
      ? `Classifying tasks ${progress?.completed ?? 0} of ${progress?.total ?? 0}`
      : status === "deriving" || status === "syncing"
        ? "Deriving workstreams from task identities…"
        : status === "failed"
          ? state?.error
          : "Workstreams are automatically derived from active task identities.";

  const working =
    status === "classifying" || status === "deriving" || status === "syncing";
  const determinate =
    status === "classifying" && progress && progress.total > 0;

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
            {status === "idle" ? (
              <Icon
                name="Check"
                aria-hidden
                className="size-3.5 text-emerald-600 dark:text-emerald-400"
              />
            ) : null}
            {heading}
          </h2>
          {detail ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {detail}
            </p>
          ) : null}
          {status === "classifying" && progress ? (
            <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground/80">
              {progress.cached} already classified
              {progress.unresolved
                ? ` · ${progress.unresolved} unresolved`
                : ""}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {working ? (
            <button type="button" className={ghostButton} onClick={onCancel}>
              Refresh
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
          {!working ? (
            <button
              type="button"
              className={status === "failed" ? secondaryButton : primaryButton}
              disabled={busy}
              onClick={onStart}
            >
              {status === "failed" ? "Try again" : "Rebuild…"}
            </button>
          ) : null}
        </div>
      </div>
      {working ? (
        <>
          <ProgressBar
            value={
              determinate ? progress!.completed / progress!.total : null
            }
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
  const percent = value !== null ? Math.round(value * 100) : null;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={percent ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      className="relative mt-3 h-1 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          "h-full bg-primary transition-[width] duration-200",
          percent === null && "w-1/3 animate-pulse",
        )}
        style={{ width: percent !== null ? `${percent}%` : undefined }}
      />
    </div>
  );
}
