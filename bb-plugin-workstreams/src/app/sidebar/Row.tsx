import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
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
import { SnoozeIcon, WakeIcon } from "../snooze/icons.tsx";
import { snoozeMenuContentClass } from "../snooze/SnoozeMenuItems.tsx";
import { Hint } from "../Hint.tsx";
import { usePortalScopeProps } from "@/lib/portal-scope";

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

/** The work state the row shows as a mark, if any. */
function shownWorkState(
  work: WorkView | undefined,
  attention: boolean | undefined,
) {
  return work?.kind === "current" &&
    !(attention && work.analysis.state === "needs_decision")
    ? work.analysis.state
    : null;
}

/**
 * BB's own status is the primary mark: working, unread, waiting, error.
 * Workstreams' assessed state is only shown when BB has none to report.
 */
function hasNativeStatus(thread: PluginSidebarThread): boolean {
  return (
    Boolean(statusRole(thread.indicator)) ||
    thread.hasPendingInteraction ||
    thread.isUnread
  );
}

/**
 * Whether the row draws anything in its status slot. A list whose rows all
 * draw nothing hides the slot, so titles sit flush left.
 */
export function hasStatusMark(
  thread: PluginSidebarThread,
  work: WorkView | undefined,
  attention?: boolean,
): boolean {
  if (hasNativeStatus(thread)) return true;
  const state = shownWorkState(work, attention);
  return Boolean(state && WORK_STATE[state].glyph);
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
  showStatusSlot = true,
  subtitle,
  snoozeAction,
  disclosure,
  onNavigate,
}: {
  thread: PluginSidebarThread;
  depth: number;
  active: boolean;
  now: number;
  /** Shown instead of the age in overlay bands: the row's workstream name. */
  context?: string;
  /**
   * The row is in the For you section. Every row there needs Tom, so the
   * needs-decision mark is implied and left out, and the title reads at full
   * strength.
   */
  attention?: boolean;
  work?: WorkView;
  /** Banner text of a proposal that involves this thread. */
  proposal?: string;
  /**
   * False when no row in this list has a status mark: the slot collapses,
   * animated, so titles sit flush left.
   */
  showStatusSlot?: boolean;
  /** A second line under the title, such as what the thread asks of Tom. */
  subtitle?: string | null;
  /**
   * The hover button after Archive: snooze with the default choice, or wake
   * a snoozed thread. `title` names what a click does; `menu` holds the other
   * choices, opened from a chevron beside the button.
   */
  snoozeAction?: {
    kind: "snooze" | "wake";
    title: string;
    run: () => void;
    menu?: ReactNode;
  };
  /** Present when the row has child threads: the expand/collapse toggle. */
  disclosure?: { expanded: boolean; toggle: () => void };
  onNavigate: () => void;
}) {
  const shownState = shownWorkState(work, attention);
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
  const nativeStatus = hasNativeStatus(thread);
  const { pullRequest } = experimental_useSidebarThreadPullRequest(thread.id);

  return (
    <div
      className={cn(
        "ws-row group/row relative flex gap-1.5 rounded-md pr-2 text-[13px]",
        // Two-line rows align their marks and details with the title line.
        subtitle
          ? "items-start py-1 [&>*]:mt-[2px] [&>a]:mt-0"
          : "h-7 items-center",
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
      <span
        className={cn(
          "ws-status-slot",
          disclosure && (nativeStatus || state?.glyph) && "ws-has-disclosure",
        )}
        data-collapsed={!showStatusSlot || undefined}
      >
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
        {disclosure ? (
          // Sits in the status slot: always shown when the slot is otherwise
          // empty, and swapped in for the status mark on hover.
          <button
            type="button"
            aria-label={
              disclosure.expanded ? "Hide child threads" : "Show child threads"
            }
            aria-expanded={disclosure.expanded}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              disclosure.toggle();
            }}
            className="ws-disclosure absolute inset-0 z-10 flex cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <Icon
              name={disclosure.expanded ? "ChevronDown" : "ChevronRight"}
              className="size-3"
            />
          </button>
        ) : null}
      </span>
      <span
        className={cn(
          "pointer-events-none relative flex min-w-0 flex-1 flex-col",
          thread.isUnread || active
            ? "font-medium text-foreground"
            : attention
              ? "text-foreground"
              : "text-muted-foreground group-hover/row:text-foreground",
        )}
      >
        <span className="truncate">
          <ThreadTitle threadId={thread.id} />
        </span>
        {subtitle ? (
          <span className="truncate text-[11.5px] leading-4 text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
      {/* Shown until the hover buttons take their place, as in BB's row. */}
      <span className="pointer-events-none relative flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground/70 empty:hidden group-hover/row:hidden group-has-[:focus-visible]/row:hidden group-has-[[data-state=open]]/row:hidden">
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
      </span>
      {/* Archive, then snooze and its chevron, left of the age. Collapsed
          rather than display:none, so keyboard focus can reach them;
          focusing one opens the group, and so does an open menu. The
          negative margin cancels the row's gap while collapsed. */}
      <span className="relative -ml-1.5 flex max-w-0 shrink-0 items-center overflow-hidden opacity-0 group-hover/row:ml-0 group-has-[:focus-visible]/row:ml-0 group-has-[[data-state=open]]/row:ml-0 group-hover/row:max-w-24 group-hover/row:opacity-100 group-has-[:focus-visible]/row:max-w-24 group-has-[:focus-visible]/row:opacity-100 group-has-[[data-state=open]]/row:max-w-24 group-has-[[data-state=open]]/row:opacity-100 pointer-coarse:hidden">
        <HoverAction label="Archive" onClick={() => actions.archive(thread.id)}>
          <Icon name="Archive" className="size-3.5" />
        </HoverAction>
        {snoozeAction ? (
          <HoverAction label={snoozeAction.title} onClick={snoozeAction.run}>
            {snoozeAction.kind === "wake" ? (
              <WakeIcon className="size-3.5" />
            ) : (
              <SnoozeIcon className="size-3.5" />
            )}
          </HoverAction>
        ) : null}
        {snoozeAction?.menu ? (
          <SnoozeChevron>{snoozeAction.menu}</SnoozeChevron>
        ) : null}
      </span>
      {/* A fixed-width column, so ages line up down the list; only a
          four-digit age like "100w" widens it. */}
      <span className="pointer-events-none relative min-w-6 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/70">
        {shortcut ? (
          <span className="rounded border border-border px-1 text-[10px]">
            {shortcut.label}
          </span>
        ) : context ? (
          <span className="block max-w-24 truncate">{context}</span>
        ) : (
          relativeAge(thread.latestAttentionAt, now)
        )}
      </span>
    </div>
  );
}

/** The chevron beside the snooze button: every other snooze choice. */
function SnoozeChevron({ children }: { children: ReactNode }) {
  const portalScope = usePortalScopeProps();
  return (
    <DropdownMenu.Root>
      <HoverAction label="More snooze options" className="w-3.5" trigger>
        <Icon name="ChevronDown" className="size-3" />
      </HoverAction>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...portalScope}
          align="end"
          sideOffset={4}
          className={snoozeMenuContentClass}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * A row button (see the hover group in `Row`), with a tooltip naming it. It stops pointer and mouse downs so it
 * never starts a drag, and clicks so it never opens the row. With `trigger`
 * it opens the enclosing dropdown menu instead of running `onClick`.
 */
function HoverAction({
  label,
  onClick,
  className,
  trigger = false,
  children,
}: {
  label: string;
  onClick?: () => void;
  className?: string;
  trigger?: boolean;
  children: ReactNode;
}) {
  const button = (
    <HoverButton label={label} onRun={onClick} className={className}>
      {children}
    </HoverButton>
  );
  return trigger ? (
    <DropdownMenu.Trigger asChild>
      <Hint label={label}>{button}</Hint>
    </DropdownMenu.Trigger>
  ) : (
    <Hint label={label}>{button}</Hint>
  );
}

const HoverButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { label: string; onRun?: () => void }
>(function HoverButton(
  { label, onRun, className, children, onPointerDown, onClick, ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      aria-label={label}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick?.(event);
        onRun?.();
      }}
      className={cn(
        "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
});
