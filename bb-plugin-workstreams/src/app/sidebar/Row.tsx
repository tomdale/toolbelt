import {
  ThreadTitle,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
  useSidebarThreadShortcut,
  type PluginSidebarPullRequest,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  WORK_STATE,
  relativeAge,
  statusRole,
} from "../../domain/presentation.ts";
import type { WorkView } from "../useWorkstreams.ts";
import { StatusMark } from "./StatusMark.tsx";

const INDENT_PX = 12;
const MAX_INDENT = 4;

function prTone(pr: PluginSidebarPullRequest): string {
  if (pr.state === "merged") return "ws-pr-merged";
  if (pr.state === "closed") return "ws-pr-closed";
  if (pr.state === "draft") return "ws-pr-draft";
  if (pr.attention === "checks_failed" || pr.attention === "conflicts")
    return "ws-pr-failed";
  if (pr.attention === "changes_requested" || pr.attention === "blocked")
    return "ws-pr-attention";
  return "ws-pr-open";
}

export function Row({
  thread,
  depth,
  active,
  now,
  context,
  attention,
  work,
  proposal,
  onNavigate,
}: {
  thread: PluginSidebarThread;
  depth: number;
  active: boolean;
  now: number;
  /** Shown instead of the age in overlay bands: the row's workstream name. */
  context?: string;
  /**
   * The row is in the Needs you section. Every row there needs Tom, so the
   * needs-decision mark is implied and left out, and the title reads at full
   * strength.
   */
  attention?: boolean;
  work?: WorkView;
  /** Banner text of a proposal that involves this thread. */
  proposal?: string;
  onNavigate: () => void;
}) {
  const shownState =
    work?.kind === "current" &&
    !(attention && work.analysis.state === "needs_decision")
      ? work.analysis.state
      : null;
  const state = shownState ? WORK_STATE[shownState] : null;
  const recap =
    work?.kind === "current"
      ? work.analysis.recap
      : work?.kind === "pending"
        ? `Updating… (was: ${work.previous.recap})`
        : undefined;
  const actions = experimental_useSidebarThreadActions();
  const { splitProps } = experimental_useSidebarThreadSplit(thread.id);
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
  // BB's own status is the primary pill. Workstreams' assessed state is only
  // shown when BB has no active/unread/draft/error/waiting status to report.
  const nativeStatus =
    Boolean(statusRole(thread.indicator)) ||
    thread.hasPendingInteraction ||
    thread.isUnread;
  const { pullRequest } = experimental_useSidebarThreadPullRequest(thread.id);

  return (
    <div
      className={cn(
        "ws-row group/row relative flex h-7 items-center gap-1.5 rounded-md pr-2 text-[13px]",
        active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
      )}
      style={{ paddingLeft: 6 + Math.min(depth, MAX_INDENT) * INDENT_PX }}
    >
      {/* Must stay an anchor: BB's thread shortcuts find rows by these
            data attributes, and modifier-click opens a split. */}
      <a
        {...splitProps}
        href={thread.href}
        data-sidebar-thread-shortcut-target=""
        data-sidebar-thread-id={thread.id}
        aria-current={active ? "page" : undefined}
        aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
        aria-label={
          state?.glyph
            ? `${thread.displayTitle}, ${state.label}`
            : thread.displayTitle
        }
        aria-describedby={recap ? `ws-recap-${thread.id}` : undefined}
        title={recap ? `${thread.displayTitle}\n${recap}` : undefined}
        onClick={(event) => {
          event.preventDefault();
          actions.open(thread.id, { split: event.metaKey || event.ctrlKey });
          onNavigate();
        }}
        className="absolute inset-0 rounded-md"
      />
      {recap ? (
        <span id={`ws-recap-${thread.id}`} hidden>
          {recap}
        </span>
      ) : null}
      <span className="ws-status-slot">
        {nativeStatus ? (
          <StatusMark
            indicator={thread.indicator}
            label={thread.indicatorLabel}
            hasPendingInteraction={thread.hasPendingInteraction}
            isUnread={thread.isUnread}
          />
        ) : null}
        {state?.glyph && !nativeStatus ? (
          <span
            className={`ws-work ws-work-${shownState} relative inline-flex size-3.5 shrink-0 items-center justify-center`}
            role="img"
            aria-label={state.label}
            title={state.label}
          >
            {state.glyph}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "pointer-events-none relative min-w-0 flex-1 truncate",
          thread.isUnread || active
            ? "font-medium text-foreground"
            : attention
              ? "text-foreground"
              : "text-muted-foreground group-hover/row:text-foreground",
        )}
      >
        <ThreadTitle threadId={thread.id} />
      </span>
      <span className="pointer-events-none relative flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground/70 group-hover/row:opacity-0 group-has-[button:focus-visible]/row:opacity-0">
        {proposal ? (
          <span className="ws-proposal-dot" role="img" aria-label={proposal} />
        ) : null}
        {rowStatus ? (
          <span title={rowStatus.label} aria-label={rowStatus.label} role="img">
            <Icon name={rowStatus.icon} className="size-3" />
          </span>
        ) : hasUnsubmittedDraft ? (
          <span title="Unsent draft" aria-label="Unsent draft" role="img">
            ✎
          </span>
        ) : null}
        {pullRequest ? (
          <span
            className={cn("ws-pr", prTone(pullRequest))}
            title={`#${pullRequest.number} ${pullRequest.title}`}
          >
            #{pullRequest.number}
          </span>
        ) : null}
        {shortcut ? (
          <span className="rounded border border-border px-1 text-[10px]">
            {shortcut.label}
          </span>
        ) : context ? (
          <span className="max-w-24 truncate">{context}</span>
        ) : (
          <span>{relativeAge(thread.latestAttentionAt, now)}</span>
        )}
      </span>
      {/* Replaces the trailing details on hover, as in BB's own row. It
            stops pointer and mouse downs so it never starts a drag. */}
      <button
        type="button"
        aria-label="Archive thread"
        title="Archive"
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          actions.archive(thread.id);
        }}
        className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 pointer-coarse:hidden"
      >
        <Icon name="Archive" className="size-3.5" />
      </button>
    </div>
  );
}
