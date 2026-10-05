/**
 * The Organization tab: what the organizer did with each thread. Each thread's
 * topic decides its workstream; threads with no topic stay Unfiled.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRealtime, type useRpc } from "@get-bb/plugin-sdk/app";
import type {
  OrganizerState,
  OrganizerStateGroup,
  OrganizerStateGroupMember,
  OrganizerStateUnresolved,
  RpcContract,
} from "../../server/contract.ts";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { ghostButton, primaryButton, secondaryButton } from "./controls.ts";
import { TaskIdentity } from "../task/TaskIdentity.tsx";
import { WorkstreamName } from "../WorkstreamName.tsx";
import { TAG_ICON } from "../workstream-icon.ts";

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
  /** Optional slot for cross-surface identity correction control. */
  renderTaskAction?: (task: { id: string; title: string }) => ReactNode;
  children?: ReactNode;
}) {
  const [state, setState] = useState<OrganizerState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requested = useRef(0);
  const settled = useRef(0);
  const command = useRef(0);
  const errorOwner = useRef<"read" | "command" | null>(null);

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
    <section aria-label="Organization" className="flex flex-col gap-6 text-sm">
      <StatusPanel
        state={state}
        busy={busy}
        alert={commandError}
        onRetry={() => void send("rebuild")}
        onRebuild={() => void send("rebuild")}
        onRefresh={() => void read()}
        onShowActivity={onShowActivity}
      />

      {state && state.counts ? <CountsSummary counts={state.counts} /> : null}

      {state && state.unresolved.length > 0 ? (
        <UnresolvedSection
          unresolved={state.unresolved}
          renderTaskAction={renderTaskAction}
        />
      ) : null}

      {state && state.groups.length > 0 ? (
        <LiveGroupsSection
          groups={state.groups}
          renderTaskAction={renderTaskAction}
        />
      ) : null}

      {!working ? children : null}
    </section>
  );
}

function CountsSummary({ counts }: { counts: OrganizerState["counts"] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div className="rounded-lg border border-border bg-card p-3">
        <span className="text-[11px] font-medium text-muted-foreground">
          Active threads
        </span>
        <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
          {counts.activeRoots}
        </p>
      </div>
      <div className="rounded-lg border border-border bg-card p-3">
        <span className="text-[11px] font-medium text-muted-foreground">
          Active workstreams
        </span>
        <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
          {counts.activeWorkstreams}
        </p>
      </div>
      <div className="rounded-lg border border-border bg-card p-3">
        <span className="text-[11px] font-medium text-muted-foreground">
          No topic
        </span>
        <p
          className={cn(
            "mt-0.5 text-lg font-semibold tabular-nums",
            counts.unresolvedRoots > 0
              ? "text-amber-600 dark:text-amber-400"
              : "text-foreground",
          )}
        >
          {counts.unresolvedRoots}
        </p>
      </div>
      <div className="rounded-lg border border-border bg-card p-3">
        <span className="text-[11px] font-medium text-muted-foreground">
          Done
        </span>
        <p className="mt-0.5 text-lg font-semibold tabular-nums text-muted-foreground">
          {counts.completedRoots}
        </p>
      </div>
    </div>
  );
}

function StatusPanel({
  state,
  busy,
  alert,
  onRetry,
  onRebuild,
  onRefresh,
}: {
  state: OrganizerState | null;
  busy: boolean;
  alert: ReactNode;
  onRetry: () => void;
  onRebuild: () => void;
  onRefresh: () => void;
  onShowActivity?: () => void;
}) {
  const status = state?.status ?? "idle";
  const progress = state?.progress;
  const heading =
    status === "classifying"
      ? "Analyzing threads"
      : status === "deriving" || status === "syncing"
        ? "Updating workstreams"
        : status === "failed"
          ? "Organizing stopped"
          : "Workstreams up to date";

  const detail =
    status === "classifying"
      ? `Analyzing threads ${progress?.completed ?? 0} of ${progress?.total ?? 0}`
      : status === "deriving" || status === "syncing"
        ? "Filing threads by topic…"
        : status === "failed"
          ? state?.error
          : "Each thread is in the workstream for its topic.";

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
            <button type="button" className={ghostButton} onClick={onRefresh}>
              Refresh
            </button>
          ) : null}
          {status === "failed" ? (
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              onClick={onRetry}
            >
              Try again
            </button>
          ) : null}
          {!working && status !== "failed" ? (
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={onRebuild}
            >
              Rebuild…
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
                ? `Analyzing threads ${progress!.completed} of ${progress!.total}`
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

function UnresolvedSection({
  unresolved,
  renderTaskAction,
}: {
  unresolved: OrganizerStateUnresolved[];
  renderTaskAction?: (task: { id: string; title: string }) => ReactNode;
}) {
  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <Icon
          name="HelpCircle"
          className="size-4 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <h2 className="text-xs font-semibold text-foreground">
          Threads with no topic ({unresolved.length})
        </h2>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Workstreams couldn't tell what these threads are about, so they are
        Unfiled. Setting a topic files them in its workstream.
      </p>
      <ul className="mt-3 divide-y divide-border/50">
        {unresolved.map((task) => (
          <li
            key={task.id}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <div className="min-w-0 flex-1">
              <span className="font-medium text-foreground">{task.title}</span>
              {task.reason ? (
                <p className="text-[11px] text-muted-foreground">
                  {task.reason}
                </p>
              ) : null}
            </div>
            <div className="shrink-0">
              {renderTaskAction ? (
                renderTaskAction(task)
              ) : (
                <TaskIdentity threadId={task.id} />
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LiveGroupsSection({
  groups,
  renderTaskAction,
}: {
  groups: OrganizerStateGroup[];
  renderTaskAction?: (task: { id: string; title: string }) => ReactNode;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Derived Workstreams ({groups.length})
      </h2>
      <div className="space-y-3">
        {groups.map((group) => (
          <GroupCard
            key={group.key}
            group={group}
            renderTaskAction={renderTaskAction}
          />
        ))}
      </div>
    </div>
  );
}

function GroupCard({
  group,
  renderTaskAction,
}: {
  group: OrganizerStateGroup;
  renderTaskAction?: (task: { id: string; title: string }) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <WorkstreamName
              name={group.name}
              className="font-semibold text-sm"
            />
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
              {group.activeCount} active · {group.totalCount} total
            </span>
          </div>
          {group.description ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {group.description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className={ghostButton}
          aria-expanded={expanded}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>

      {expanded && group.roots.length > 0 ? (
        <ul className="mt-3 divide-y divide-border/40 border-t border-border/40 pt-1">
          {group.roots.map((root) => (
            <GroupMemberRow
              key={root.id}
              root={root}
              renderTaskAction={renderTaskAction}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function GroupMemberRow({
  root,
  renderTaskAction,
}: {
  root: OrganizerStateGroupMember;
  renderTaskAction?: (task: { id: string; title: string }) => ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "font-medium text-xs",
              root.completed
                ? "text-muted-foreground line-through"
                : "text-foreground",
            )}
          >
            {root.title}
          </span>
          {root.topicLabel ? (
            <span className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground font-medium">
              <Icon
                name={TAG_ICON}
                className="size-2.5 opacity-70"
                aria-hidden="true"
              />
              {root.topicLabel}
            </span>
          ) : null}
        </div>
        {root.reason ? (
          <p className="mt-0.5 text-[11px] text-muted-foreground/80">
            {root.reason}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">
        {renderTaskAction ? (
          renderTaskAction(root)
        ) : (
          <TaskIdentity threadId={root.id} />
        )}
      </div>
    </li>
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
