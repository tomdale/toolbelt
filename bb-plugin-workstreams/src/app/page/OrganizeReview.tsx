/**
 * The Organize review: a saved preview shown as the change Apply would make.
 * The whole proposal is one decision, so rows explain placements but offer no
 * per-task vetoes. Workstreams list A–Z; the Moves view lists every move.
 */
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { useDebugMode } from "../debug/debug.ts";
import { ghostButton, primaryButton, secondaryButton } from "./controls.ts";
import { WorkstreamName } from "../WorkstreamName.tsx";
import { TAG_ICON } from "../workstream-icon.ts";
import type { Review, ReviewGroup, ReviewTask } from "./organize-review.ts";

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

type View = "workstreams" | "moves";

/** The saved preview, restated as the change Apply would make. */
export function ProposalReview({
  review,
  busy,
  inspect,
  alert,
  renderTaskAction,
  onApply,
  onDiscard,
  onRegenerate,
}: {
  review: Review;
  busy: boolean;
  inspect: ReactNode;
  alert: ReactNode;
  /** Optional slot for cross-surface identity correction control from Phase 3. */
  renderTaskAction?: (task: ReviewTask) => ReactNode;
  onApply: () => void;
  onDiscard: () => void;
  onRegenerate: () => void;
}) {
  const [view, setView] = useState<View>("workstreams");
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const { summary } = review;
  const expandable = [...review.groups, ...review.removed];
  const allOpen =
    expandable.length > 0 && expandable.every((g) => open.has(g.key));
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const empty = summary.tasks === 0;
  return (
    <div className="flex flex-col gap-5">
      <header className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-background/90 px-2 pb-3 pt-1 backdrop-blur">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="flex items-center gap-1.5 text-[13px] font-medium">
            Review proposed organization
            {review.isStale ? (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                <Icon name="AlertTriangle" aria-hidden className="size-3" />
                Stale proposal
              </span>
            ) : null}
            {inspect}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {empty
              ? "There are no open tasks to organize."
              : review.isStale
                ? "The catalog or task classifications changed since this proposal was prepared. Regenerate to update."
                : summary.moving === 0
                  ? "All tasks are already in their recommended workstreams. Nothing changes until you apply."
                  : `${summary.moving} of ${plural(summary.tasks, "task")} move. Nothing changes until you apply.`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className={review.isStale ? primaryButton : ghostButton}
            disabled={busy}
            onClick={onRegenerate}
            title="Discard this proposal and prepare a new one"
          >
            Regenerate
          </button>
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={onDiscard}
          >
            Discard
          </button>
          <button
            type="button"
            className={review.isStale ? ghostButton : primaryButton}
            disabled={busy || empty || review.isStale}
            onClick={onApply}
            title={
              review.isStale
                ? "Proposal is stale. Regenerate before applying."
                : undefined
            }
          >
            Apply organization
          </button>
        </div>
      </header>
      {review.isStale ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300"
        >
          <Icon
            name="AlertTriangle"
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
          />
          <div className="flex-1">
            <p className="font-medium">Proposal is stale</p>
            <p className="mt-0.5 text-muted-foreground">
              The catalog or task classifications changed since this proposal
              was generated. Apply is disabled; regenerate to prepare an
              up-to-date proposal.
            </p>
          </div>
          <button
            type="button"
            className={cn(primaryButton, "h-7 shrink-0 text-xs")}
            onClick={onRegenerate}
            disabled={busy}
          >
            Regenerate
          </button>
        </div>
      ) : null}
      {alert}
      {empty ? null : (
        <>
          <Summary review={review} />
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <div
                role="group"
                aria-label="Review by"
                className="flex rounded-lg bg-state-hover/60 p-0.5 text-xs"
              >
                {(
                  [
                    ["workstreams", "Workstreams"],
                    [
                      "moves",
                      `Moves${summary.moving ? ` ${summary.moving}` : ""}`,
                    ],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={view === id}
                    onClick={() => setView(id)}
                    className={cn(
                      "rounded-md px-2.5 py-0.5 tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                      view === id
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="flex-1" />
              {view === "workstreams" && expandable.length ? (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() =>
                    setOpen(
                      allOpen
                        ? new Set()
                        : new Set(expandable.map((g) => g.key)),
                    )
                  }
                >
                  {allOpen ? "Collapse all" : "Expand all"}
                </button>
              ) : null}
            </div>
            {view === "workstreams" ? (
              <GroupList
                review={review}
                open={open}
                onToggle={toggle}
                renderTaskAction={renderTaskAction}
              />
            ) : (
              <MoveList
                moves={review.moves}
                renderTaskAction={renderTaskAction}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Summary({ review }: { review: Review }) {
  const { summary } = review;
  const cells: { label: string; value: number; detail: string }[] = [
    {
      label: "Moving",
      value: summary.moving,
      detail: summary.moving === 1 ? "task" : "tasks",
    },
    {
      label: "Staying",
      value: summary.staying,
      detail: summary.staying === 1 ? "task" : "tasks",
    },
    {
      label: "New",
      value: summary.created,
      detail: summary.created === 1 ? "workstream" : "workstreams",
    },
    {
      label: "Renamed",
      value: summary.renamed,
      detail: summary.renamed === 1 ? "workstream" : "workstreams",
    },
    {
      label: "Removed",
      value: summary.removed,
      detail: summary.removed === 1 ? "workstream" : "workstreams",
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <dl
        aria-label="Proposed changes"
        className="grid grid-cols-5 overflow-hidden rounded-xl border border-border"
      >
        {cells.map((cell, index) => (
          <div
            key={cell.label}
            className={cn(
              "flex min-w-0 flex-col gap-0.5 border-border px-2.5 py-2 sm:px-3.5 sm:py-2.5",
              index > 0 && "border-l",
            )}
          >
            <dt className="text-[11px] text-muted-foreground">{cell.label}</dt>
            <dd className="flex flex-col gap-0.5">
              <span
                className={cn(
                  "text-lg font-semibold leading-tight tracking-tight tabular-nums",
                  cell.value === 0 && "text-muted-foreground/60",
                )}
              >
                {cell.value}
              </span>
              <span className="hidden truncate text-[11px] text-muted-foreground sm:block">
                {cell.detail}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      {summary.childThreads || summary.declined ? (
        <p className="text-xs text-muted-foreground">
          {summary.childThreads
            ? `Counts are task threads. Child threads stay with their task, so ${summary.movingChildren} of ${plural(summary.childThreads, "child thread")} move too.`
            : null}
          {summary.childThreads && summary.declined ? " " : null}
          {summary.declined
            ? `${plural(summary.declined, "suggested move")} won’t be applied; ${summary.declined === 1 ? "that task stays" : "those tasks stay"} where ${summary.declined === 1 ? "it is" : "they are"}.`
            : null}
        </p>
      ) : null}
      {summary.completedTasks || summary.unresolvedTasks ? (
        <p className="text-xs text-muted-foreground">
          Counts reflect task roots ({summary.currentTasks} active
          {summary.completedTasks
            ? ` · ${summary.completedTasks} completed retained`
            : ""}
          {summary.unresolvedTasks
            ? ` · ${summary.unresolvedTasks} unresolved retained`
            : ""}
          ).
        </p>
      ) : null}
    </div>
  );
}

function GroupList({
  review,
  open,
  onToggle,
  renderTaskAction,
}: {
  review: Review;
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  renderTaskAction?: (task: ReviewTask) => ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div
        aria-hidden
        className="hidden grid-cols-[1rem_minmax(0,1fr)_5rem_8rem] gap-x-3 border-b border-border bg-state-hover/30 px-3 py-1.5 text-[11px] text-muted-foreground sm:grid"
      >
        <span />
        <span>Workstream</span>
        <span className="text-right">Tasks</span>
        <span className="text-right">Change</span>
      </div>
      <ul
        aria-label="Workstreams after Apply"
        className="divide-y divide-border"
      >
        {review.groups.map((group) => (
          <GroupRow
            key={group.key}
            group={group}
            open={open.has(group.key)}
            onToggle={() => onToggle(group.key)}
            renderTaskAction={renderTaskAction}
          />
        ))}
      </ul>
      {review.removed.length ? (
        <>
          <div className="flex items-baseline gap-2 border-y border-border bg-state-hover/30 px-3 py-1.5">
            <h3 className="text-[11px] font-medium text-muted-foreground">
              Removed
            </h3>
            <p className="text-[11px] text-muted-foreground/80">
              Empty or archived-only. Threads are kept, and Undo restores the
              workstream.
            </p>
          </div>
          <ul
            aria-label="Workstreams Apply removes"
            className="divide-y divide-border"
          >
            {review.removed.map((group) => (
              <GroupRow
                key={group.key}
                group={group}
                open={open.has(group.key)}
                onToggle={() => onToggle(group.key)}
                renderTaskAction={renderTaskAction}
              />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function changeOf(group: ReviewGroup): string {
  if (group.kind === "removed")
    return group.outgoing.length
      ? `Removed · −${group.outgoing.length} out`
      : "Removed";
  const parts = [
    group.incoming.length ? `+${group.incoming.length} in` : "",
    group.outgoing.length ? `−${group.outgoing.length} out` : "",
  ].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  if (group.renamedFrom) return "Renamed";
  if (group.previousDescription !== null) return "New description";
  return "No change";
}

function GroupRow({
  group,
  open,
  onToggle,
  renderTaskAction,
}: {
  group: ReviewGroup;
  open: boolean;
  onToggle: () => void;
  renderTaskAction?: (task: ReviewTask) => ReactNode;
}) {
  const panel = useId();
  const change = changeOf(group);
  const quiet = change === "No change";
  const before = group.kind === "new" ? "–" : String(group.before);
  const after = group.kind === "removed" ? "–" : String(group.after);
  return (
    <li className={cn(open && "bg-state-hover/25")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={onToggle}
        className="grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2 text-left hover:bg-state-hover/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:grid-cols-[1rem_minmax(0,1fr)_5rem_8rem]"
      >
        <Icon
          name="ChevronRight"
          aria-hidden
          className={cn(
            "size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="flex min-w-0 items-baseline gap-2">
          <WorkstreamName
            name={group.name}
            muted={group.kind === "removed" || group.kind === "unfiled"}
            className={cn(
              "text-[13px] font-medium",
              group.kind === "removed" &&
                "line-through decoration-muted-foreground/50",
            )}
          />
          {group.kind === "new" ? <Badge tone="new">New</Badge> : null}
          {group.renamedFrom ? (
            <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
              was {group.renamedFrom}
            </span>
          ) : null}
        </span>
        <span
          className="text-right text-xs tabular-nums text-muted-foreground"
          aria-label={`${before === "–" ? "none" : before} now, ${after === "–" ? "none" : after} after`}
        >
          {before}
          <span aria-hidden className="mx-1 text-muted-foreground/50">
            →
          </span>
          <span
            className={cn(
              group.after !== group.before &&
                after !== "–" &&
                "text-foreground",
            )}
          >
            {after}
          </span>
        </span>
        <span
          className={cn(
            "hidden truncate text-right text-xs tabular-nums sm:block",
            quiet ? "text-muted-foreground/60" : "text-foreground/80",
          )}
        >
          {change}
        </span>
      </button>
      <div
        id={panel}
        role="region"
        aria-label={`${group.name} details`}
        hidden={!open}
        className="px-3 pb-3 pl-10"
      >
        <GroupDetail group={group} renderTaskAction={renderTaskAction} />
      </div>
    </li>
  );
}

function GroupDetail({
  group,
  renderTaskAction,
}: {
  group: ReviewGroup;
  renderTaskAction?: (task: ReviewTask) => ReactNode;
}) {
  const [allStaying, setAllStaying] = useState(false);
  const limit = 6;
  const staying =
    allStaying || group.staying.length <= limit + 1
      ? group.staying
      : group.staying.slice(0, limit);
  return (
    <div className="flex flex-col gap-3">
      {group.renamedFrom ? (
        <p className="text-xs text-muted-foreground sm:hidden">
          Renamed from {group.renamedFrom}
        </p>
      ) : null}
      {group.kind === "removed" ? (
        <p className="text-xs text-muted-foreground">
          {group.archivedThreads
            ? `${plural(group.archivedThreads, "archived thread")} stay archived and keep their history.`
            : "Holds no threads."}
        </p>
      ) : group.description ? (
        <div className="text-xs leading-relaxed text-muted-foreground">
          <p>{group.description}</p>
          {group.previousDescription !== null ? (
            <p className="mt-1 text-muted-foreground/70">
              <span className="font-medium">Replaces:</span>{" "}
              {group.previousDescription || "No description"}
            </p>
          ) : null}
        </div>
      ) : null}
      <TaskSection
        label="Moving in"
        tasks={group.incoming}
        side="from"
        renderTaskAction={renderTaskAction}
      />
      <TaskSection
        label="Moving out"
        tasks={group.outgoing}
        side="to"
        renderTaskAction={renderTaskAction}
      />
      {group.staying.length ? (
        <div>
          <h4 className="text-[11px] font-medium text-muted-foreground">
            Staying · {group.staying.length}
          </h4>
          <ul className="mt-1">
            {staying.map((task) => (
              <TaskLine
                key={task.id}
                task={task}
                muted
                renderTaskAction={renderTaskAction}
              />
            ))}
          </ul>
          {staying.length < group.staying.length ? (
            <button
              type="button"
              className="mt-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => setAllStaying(true)}
            >
              Show {group.staying.length - staying.length} more
            </button>
          ) : null}
        </div>
      ) : null}
      {!group.incoming.length &&
      !group.outgoing.length &&
      !group.staying.length ? (
        <p className="text-xs text-muted-foreground">No open tasks.</p>
      ) : null}
    </div>
  );
}

function TaskSection({
  label,
  tasks,
  side,
  renderTaskAction,
}: {
  label: string;
  tasks: ReviewTask[];
  side: "from" | "to";
  renderTaskAction?: (task: ReviewTask) => ReactNode;
}) {
  if (!tasks.length) return null;
  return (
    <div>
      <h4 className="text-[11px] font-medium text-muted-foreground">
        {label} · {tasks.length}
      </h4>
      <ul className="mt-1">
        {tasks.map((task) => (
          <TaskLine
            key={task.id}
            task={task}
            note={`${side} ${side === "from" ? task.fromName : task.toName}`}
            renderTaskAction={renderTaskAction}
          />
        ))}
      </ul>
    </div>
  );
}

function TaskLine({
  task,
  note,
  muted = false,
  renderTaskAction,
}: {
  task: ReviewTask;
  note?: string;
  muted?: boolean;
  renderTaskAction?: (task: ReviewTask) => ReactNode;
}) {
  const debug = useDebugMode();
  return (
    <li className="py-1 text-[13px]">
      <div className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-3">
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            muted ? "text-muted-foreground" : "text-foreground/90",
          )}
        >
          {task.title}
          <ChildCount count={task.children} />
          {task.declined ? (
            <span className="ml-2 text-[11px] text-muted-foreground">
              Suggested move not applied
            </span>
          ) : null}
        </span>
        {note ? (
          <span className="truncate text-xs text-muted-foreground sm:max-w-[45%] sm:shrink-0">
            {note}
          </span>
        ) : null}
        {renderTaskAction ? renderTaskAction(task) : null}
      </div>
      {task.identityLabel ||
      (task.identityStatus === "unresolved" && task.retained) ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {task.identityLabel ? (
            <span className="inline-flex items-center gap-1 font-medium text-foreground/80">
              <Icon
                name={TAG_ICON}
                aria-hidden
                className="size-3 text-muted-foreground/70"
              />
              <span>{task.identityLabel}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 italic text-muted-foreground/80">
              <Icon
                name="HelpCircle"
                aria-hidden
                className="size-3 text-muted-foreground/60"
              />
              <span>Unresolved identity</span>
            </span>
          )}
          {task.provenance === "manual" ? (
            <span className="rounded bg-state-hover px-1 py-0.2 text-[10px] text-muted-foreground">
              manual
            </span>
          ) : null}
          {task.completed ? (
            <span className="rounded bg-emerald-500/10 px-1 py-0.2 text-[10px] text-emerald-600 dark:text-emerald-400">
              completed
            </span>
          ) : null}
          {task.retained && task.fromName && !task.identityLabel ? (
            <span className="text-[10px] text-muted-foreground/70">
              · retained in {task.fromName}
            </span>
          ) : null}
        </div>
      ) : null}
      {debug && task.reason ? (
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
          {task.reason}
        </p>
      ) : null}
    </li>
  );
}

function ChildCount({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="ml-1.5 text-[11px] tabular-nums text-muted-foreground">
      +{plural(count, "child thread")}
    </span>
  );
}

function MoveList({
  moves,
  renderTaskAction,
}: {
  moves: ReviewTask[];
  renderTaskAction?: (task: ReviewTask) => ReactNode;
}) {
  const debug = useDebugMode();
  if (!moves.length)
    return (
      <p className="rounded-xl border border-border px-3 py-6 text-center text-xs text-muted-foreground">
        No tasks move in this proposal.
      </p>
    );
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <table className="w-full table-fixed text-left text-[13px]">
        <caption className="sr-only">Tasks Apply moves</caption>
        <thead>
          <tr className="border-b border-border bg-state-hover/30 text-[11px] text-muted-foreground">
            <th scope="col" className="px-3 py-1.5 font-normal">
              Task
            </th>
            <th
              scope="col"
              className="hidden w-[22%] px-3 py-1.5 font-normal sm:table-cell"
            >
              From
            </th>
            <th
              scope="col"
              className="w-[38%] px-3 py-1.5 font-normal sm:w-[26%]"
            >
              To
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {moves.map((task) => (
            <tr
              key={task.id}
              className="align-baseline hover:bg-state-hover/40"
            >
              <td className="px-3 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="truncate text-foreground/90">
                    {task.title}
                    <ChildCount count={task.children} />
                  </div>
                  {renderTaskAction ? renderTaskAction(task) : null}
                </div>
                {task.identityLabel ? (
                  <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1 font-medium text-foreground/80">
                      <Icon
                        name={TAG_ICON}
                        aria-hidden
                        className="size-3 text-muted-foreground/70"
                      />
                      <span>{task.identityLabel}</span>
                    </span>
                    {task.provenance === "manual" ? (
                      <span className="rounded bg-state-hover px-1 py-0.2 text-[10px] text-muted-foreground">
                        manual
                      </span>
                    ) : null}
                    {task.completed ? (
                      <span className="rounded bg-emerald-500/10 px-1 py-0.2 text-[10px] text-emerald-600 dark:text-emerald-400">
                        completed
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {debug && task.reason ? (
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                    {task.reason}
                  </div>
                ) : null}
              </td>
              <td className="hidden truncate px-3 py-1.5 text-xs text-muted-foreground sm:table-cell">
                <WorkstreamName name={task.fromName} muted />
              </td>
              <td className="truncate px-3 py-1.5 text-xs">
                <span aria-hidden className="mr-1.5 text-muted-foreground/50">
                  →
                </span>
                <WorkstreamName name={task.toName} />
                <span className="block truncate text-[11px] text-muted-foreground sm:hidden">
                  from {task.fromName}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Badge({ tone, children }: { tone: "new"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px text-[10px] font-medium leading-none",
        tone === "new" && "bg-primary/15 text-primary",
      )}
    >
      {children}
    </span>
  );
}
