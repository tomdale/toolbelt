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
import { relativeAge } from "../../domain/presentation.ts";
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
  onNavigate,
}: {
  thread: PluginSidebarThread;
  depth: number;
  active: boolean;
  now: number;
  /** Shown instead of the age in overlay bands: the row's workstream name. */
  context?: string;
  onNavigate: () => void;
}) {
  const actions = experimental_useSidebarThreadActions();
  const { splitProps } = experimental_useSidebarThreadSplit(thread.id);
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
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
        aria-label={thread.displayTitle}
        onClick={(event) => {
          event.preventDefault();
          actions.open(thread.id, { split: event.metaKey || event.ctrlKey });
          onNavigate();
        }}
        className="absolute inset-0 rounded-md"
      />
      <StatusMark indicator={thread.indicator} label={thread.indicatorLabel} />
      <span
        className={cn(
          "pointer-events-none relative min-w-0 flex-1 truncate",
          thread.isUnread || active
            ? "font-medium text-foreground"
            : "text-muted-foreground group-hover/row:text-foreground",
        )}
      >
        <ThreadTitle threadId={thread.id} />
      </span>
      <span className="pointer-events-none relative flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground/70">
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
    </div>
  );
}
