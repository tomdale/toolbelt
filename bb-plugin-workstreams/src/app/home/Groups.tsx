import { useState, type ReactNode } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { UNSORTED_ID, type Group, type Row } from "../../domain/project.ts";
import { shortWake, type ThreadSnooze } from "../../domain/snooze.ts";
import { workstreamHue } from "../../domain/workstreamHue.ts";
import { WorkstreamName } from "../WorkstreamName.tsx";
import type { WorkView } from "../useWorkstreams.ts";
import { hasStatusMark } from "../sidebar/Row.tsx";
import { PriorityIcon } from "../sidebar/PriorityIcon.tsx";
import { HomeRow } from "./HomeRow.tsx";
import {
  descendantCount,
  startsOpen,
  unfoldedRows,
  type HomePlan,
} from "./model.ts";

type Thread = PluginSidebarThread;
type CountWhen = "always" | "collapsed" | "never";

/** What every Home list needs to draw a row. */
export type HomeEnv = {
  now: number;
  work: (thread: Thread) => WorkView;
  snoozeOf: (thread: Thread) => ThreadSnooze | undefined;
  showAge: boolean;
  threadCount: CountWhen;
  waitingCount: CountWhen;
  isOpen: (id: string, byDefault: boolean) => boolean;
  toggle: (id: string, byDefault: boolean) => void;
  setAll: (ids: readonly string[], open: boolean) => void;
};

const groupKey = (id: string) => `group:${id}`;
const treeKey = (id: string) => `thread:${id}`;
const DORMANT_KEY = "fold:dormant";
const SNOOZED_KEY = "fold:snoozed";

const showsCount = (when: CountWhen, collapsed: boolean) =>
  when === "always" || (when === "collapsed" && collapsed);

/**
 * Everything below Up Next: the workstreams that have threads, prioritized
 * ones first, then the rest, Unfiled, a Dormant fold, and a Snoozed fold.
 * While a workstream is prioritized the rest wait behind a toggle, as in the
 * sidebar. Groups start closed except prioritized ones (see `startsOpen`), and
 * Expand all opens every group at once.
 */
export function WorkstreamGroups({
  plan,
  env,
}: {
  plan: HomePlan<Thread>;
  env: HomeEnv;
}) {
  const [showLower, setShowLower] = useState(false);
  const lowerShown = !plan.tiered || showLower;
  const visibleGroups = [
    ...plan.pinned,
    ...(lowerShown
      ? [...plan.populated, ...(plan.unfiled ? [plan.unfiled] : [])]
      : []),
  ];
  const allOpen = visibleGroups.every((group) =>
    env.isOpen(groupKey(group.id), startsOpen(plan, group)),
  );
  const quiet = (group: Group<Thread>) =>
    Boolean(plan.upNext?.focused) && !group.prioritized;
  const renderGroup = (group: Group<Thread>, muted = false) => (
    <GroupSection
      key={group.id}
      group={group}
      open={env.isOpen(groupKey(group.id), startsOpen(plan, group))}
      onToggle={() => env.toggle(groupKey(group.id), startsOpen(plan, group))}
      muted={muted}
      quietCount={quiet(group)}
      env={env}
    />
  );
  const hasGroups = visibleGroups.length > 0 || plan.hasLower;
  const snoozedMarks = plan.snoozed.some((row) =>
    hasStatusMark(row.thread, env.work(row.thread)),
  );
  return (
    <>
      {hasGroups ? (
        <section aria-label="Workstreams" className="ws-home-groups">
          <div className="ws-home-section-head">
            <h2>Workstreams</h2>
            {visibleGroups.length > 1 ? (
              <button
                type="button"
                className="ws-home-text-button"
                onClick={() =>
                  env.setAll(
                    visibleGroups.map((group) => groupKey(group.id)),
                    !allOpen,
                  )
                }
              >
                {allOpen ? "Collapse all" : "Expand all"}
              </button>
            ) : null}
          </div>
          {plan.pinned.map((group) => renderGroup(group))}
          {plan.tiered && plan.hasLower ? (
            <button
              type="button"
              className="ws-home-lower-toggle"
              aria-expanded={showLower}
              onClick={() => setShowLower(!showLower)}
            >
              <span>
                {showLower
                  ? "Hide lower priority workstreams"
                  : "Show lower priority workstreams"}
              </span>
              {!showLower && plan.upNext && plan.upNext.elsewhere > 0 ? (
                <span
                  className="ws-home-pill ws-home-pill-quiet"
                  title={`${plan.upNext.elsewhere} waiting on you`}
                >
                  <span aria-hidden="true">{plan.upNext.elsewhere}</span>
                  <span className="sr-only">
                    , {plan.upNext.elsewhere} waiting on you
                  </span>
                </span>
              ) : null}
            </button>
          ) : null}
          {lowerShown ? (
            <>
              {plan.populated.map((group) => renderGroup(group))}
              {plan.unfiled ? renderGroup(plan.unfiled, true) : null}
              {plan.dormant.length > 0 ? (
                <Fold
                  id={DORMANT_KEY}
                  title="Dormant"
                  count={plan.dormant.length}
                  env={env}
                >
                  {plan.dormant.map((group) => (
                    <GroupSection
                      key={group.id}
                      group={group}
                      open={env.isOpen(groupKey(group.id), false)}
                      onToggle={() => env.toggle(groupKey(group.id), false)}
                      muted
                      quietCount={false}
                      env={env}
                    />
                  ))}
                </Fold>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
      {plan.snoozed.length > 0 ? (
        <Fold
          id={SNOOZED_KEY}
          title="Snoozed"
          count={plan.snoozed.filter((row) => row.depth === 0).length}
          env={env}
          standalone
        >
          <ul className="ws-home-rows">
            {plan.snoozed.map((row) => {
              const snooze = env.snoozeOf(row.thread);
              return (
                <HomeRow
                  key={row.thread.id}
                  thread={row.thread}
                  work={env.work(row.thread)}
                  now={env.now}
                  variant="snoozed"
                  depth={row.depth}
                  showMarkSlot={snoozedMarks}
                  showAge={env.showAge}
                  trailing={
                    snooze ? shortWake(snooze.until, env.now) : undefined
                  }
                />
              );
            })}
          </ul>
        </Fold>
      ) : null}
    </>
  );
}

/** A workstream: a header that opens and closes its threads. */
function GroupSection({
  group,
  open,
  onToggle,
  muted,
  quietCount,
  env,
}: {
  group: Group<Thread>;
  open: boolean;
  onToggle: () => void;
  muted: boolean;
  quietCount: boolean;
  env: HomeEnv;
}) {
  const isUnfiled = group.id === UNSORTED_ID;
  const rows = open
    ? unfoldedRows(
        group.rows,
        (row) => !env.isOpen(treeKey(row.thread.id), true),
      )
    : [];
  const marks = group.rows.some((row) =>
    hasStatusMark(row.thread, env.work(row.thread)),
  );
  const descendants = new Map(
    group.rows.map((row, index) => [
      row.thread.id,
      descendantCount(group.rows, index),
    ]),
  );
  return (
    <section
      aria-label={group.name}
      className="ws-home-group"
      data-open={open || undefined}
      data-muted={muted || undefined}
      data-prioritized={group.prioritized || undefined}
    >
      <h3 className="ws-home-group-head">
        <button type="button" aria-expanded={open} onClick={onToggle}>
          <Icon name="ChevronRight" className="ws-home-chevron" aria-hidden />
          {isUnfiled ? null : (
            <span
              className="ws-home-dot"
              aria-hidden="true"
              style={
                { "--ws-hue": workstreamHue(group.id) } as React.CSSProperties
              }
            />
          )}
          <WorkstreamName
            name={group.name}
            muted={muted}
            className="ws-home-group-name"
          />
          {group.prioritized ? (
            <PriorityIcon filled className="ws-home-flag-icon" />
          ) : null}
          <span className="ws-home-counts">
            {showsCount(env.waitingCount, !open) && group.needsYou > 0 ? (
              <span
                className={
                  quietCount
                    ? "ws-home-pill ws-home-pill-quiet"
                    : "ws-home-pill ws-amber-pill"
                }
                title={`${group.needsYou} waiting on you`}
              >
                {group.needsYou}
              </span>
            ) : null}
            {showsCount(env.threadCount, !open) && group.total > 0 ? (
              <span className="ws-home-total">{group.total}</span>
            ) : null}
          </span>
        </button>
      </h3>
      {open ? (
        <ul className="ws-home-rows">
          {rows.map((row: Row<Thread>) => {
            const children = descendants.get(row.thread.id) ?? 0;
            return (
              <HomeRow
                key={row.thread.id}
                thread={row.thread}
                work={env.work(row.thread)}
                now={env.now}
                variant="group"
                depth={row.depth}
                showMarkSlot={marks}
                showAge={env.showAge}
                disclosure={
                  row.hasChildren
                    ? {
                        open: env.isOpen(treeKey(row.thread.id), true),
                        count: children,
                        toggle: () => env.toggle(treeKey(row.thread.id), true),
                      }
                    : undefined
                }
              />
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/** A closed-by-default band: Dormant workstreams, or Snoozed threads. */
function Fold({
  id,
  title,
  count,
  env,
  standalone = false,
  children,
}: {
  id: string;
  title: string;
  count: number;
  env: HomeEnv;
  /** Drawn on its own, outside the Workstreams list. */
  standalone?: boolean;
  children: ReactNode;
}) {
  const open = env.isOpen(id, false);
  return (
    <section
      aria-label={title}
      className="ws-home-group ws-home-fold-section"
      data-open={open || undefined}
      data-standalone={standalone || undefined}
      data-muted=""
    >
      <h3 className="ws-home-group-head">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => env.toggle(id, false)}
        >
          <Icon name="ChevronRight" className="ws-home-chevron" aria-hidden />
          <span className="ws-home-group-name">{title}</span>
          <span className="ws-home-counts">
            <span className="ws-home-total">{count}</span>
          </span>
        </button>
      </h3>
      {open ? children : null}
    </section>
  );
}
