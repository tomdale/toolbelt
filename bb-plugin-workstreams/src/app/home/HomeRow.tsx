import {
  ThreadTitle,
  useSidebarThreadDraft,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import {
  relativeAge,
  relativeAgeLabel,
  workStateMark,
} from "../../domain/presentation.ts";
import { WorkstreamIcon } from "../WorkstreamIcon.tsx";
import type { WorkView } from "../useWorkstreams.ts";
import { hasNativeStatus, shownWorkState } from "../sidebar/Row.tsx";
import { StatusMark } from "../sidebar/StatusMark.tsx";

/**
 * One thread as a Home row: BB's status mark or the work state's, the BB
 * display title, an unsent-draft mark when there is one, and its age, in a row
 * at least 48px tall. Up Next rows add a second line naming the workstream (in
 * its hue) and what the thread asks. The row is an anchor, so BB opens the
 * thread in place on a plain tap. Its accessible name is its content (mark,
 * title, workstream, ask, age), so what a screen reader announces is what the
 * row shows.
 */
export function HomeRow({
  thread,
  work,
  now,
  variant,
  depth = 0,
  showMarkSlot,
  showAge,
  workstream,
  ask,
  trailing,
  disclosure,
}: {
  thread: PluginSidebarThread;
  work: WorkView | undefined;
  now: number;
  /** Up Next rows (every thread there needs the user), group rows, Snoozed rows. */
  variant: "attention" | "group" | "snoozed";
  depth?: number;
  /** False when no row in this list draws a mark, so titles sit flush left. */
  showMarkSlot: boolean;
  /** The Timestamp setting: ages show only when it says Always. */
  showAge: boolean;
  /** The workstream Up Next names under the title; null for Unfiled. */
  workstream?: { name: string; hue: number } | null;
  /** What the thread asks of the user, from its current analysis. */
  ask?: string | null;
  /** Replaces the age: a snoozed thread's wake time. */
  trailing?: string;
  /** Present on a thread with child threads: shows and hides them. */
  disclosure?: { open: boolean; count: number; toggle: () => void };
}) {
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const attention = variant === "attention";
  const shown = shownWorkState(work, attention);
  const reported = work?.kind === "current" && work.reported;
  const state = shown ? workStateMark(shown, reported) : null;
  return (
    <li
      className="ws-home-row"
      data-variant={variant}
      data-unread={thread.isUnread || undefined}
      style={{ "--ws-depth": Math.min(depth, 2) } as React.CSSProperties}
    >
      <a
        className="ws-home-link"
        href={thread.href}
        data-ws-home-thread={thread.id}
      >
        {showMarkSlot ? (
          <span className="ws-home-mark">
            {hasNativeStatus(thread) ? (
              <StatusMark
                indicator={thread.indicator}
                label={thread.indicatorLabel}
                hasPendingInteraction={thread.hasPendingInteraction}
                isUnread={thread.isUnread}
              />
            ) : state?.glyph ? (
              <span
                className={`ws-work ws-work-${reported && shown === "done" ? "complete" : shown}`}
                role="img"
                aria-label={state.label}
              >
                {state.glyph}
              </span>
            ) : null}
          </span>
        ) : null}
        <span className="ws-home-text">
          <span className="ws-home-title">
            <ThreadTitle threadId={thread.id} />
          </span>
          {workstream || ask ? (
            <span className="ws-home-meta">
              {workstream ? (
                <span
                  className="ws-home-ws"
                  style={{ "--ws-hue": workstream.hue } as React.CSSProperties}
                >
                  <WorkstreamIcon className="ws-home-ws-icon" />
                  <span className="ws-home-ws-name">{workstream.name}</span>
                </span>
              ) : null}
              {ask ? <span className="ws-home-ask">{ask}</span> : null}
            </span>
          ) : null}
        </span>
        {hasUnsubmittedDraft ? (
          <span className="ws-home-draft" role="img" aria-label="Unsent draft">
            ✎
          </span>
        ) : null}
        {trailing ? (
          <span className="ws-home-age">{trailing}</span>
        ) : showAge ? (
          <span className="ws-home-age">
            <span aria-hidden="true">
              {relativeAge(thread.latestAttentionAt, now)}
            </span>
            <span className="sr-only">
              {relativeAgeLabel(thread.latestAttentionAt, now)}
            </span>
          </span>
        ) : null}
      </a>
      {disclosure ? (
        <button
          type="button"
          className="ws-home-fold"
          aria-expanded={disclosure.open}
          aria-label={`${disclosure.open ? "Hide" : "Show"} ${disclosure.count} ${disclosure.count === 1 ? "thread" : "threads"} under ${thread.displayTitle}`}
          onClick={disclosure.toggle}
        >
          <span className="ws-home-fold-count" aria-hidden="true">
            {disclosure.count}
          </span>
          <Icon name="ChevronRight" className="ws-home-chevron" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}
