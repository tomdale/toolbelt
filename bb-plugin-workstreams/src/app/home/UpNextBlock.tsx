import { useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Row } from "../../domain/project.ts";
import { UP_NEXT_LIMIT } from "../../domain/upNext.ts";
import type { WorkView } from "../useWorkstreams.ts";
import { hasStatusMark } from "../sidebar/Row.tsx";
import { PriorityIcon } from "../sidebar/PriorityIcon.tsx";
import { HomeRow } from "./HomeRow.tsx";

/**
 * Up Next on Home: the threads that need the user, in the sidebar's amber
 * block. Five rows show, with Show more for the rest. Each row names its
 * workstream in the workstream's hue.
 */
export function UpNextBlock({
  rows,
  focused,
  work,
  workstreamOf,
  now,
  showAge,
}: {
  rows: readonly Row<PluginSidebarThread>[];
  /** Prioritized focus left other workstreams' threads out. */
  focused: boolean;
  work: (thread: PluginSidebarThread) => WorkView;
  workstreamOf: (
    row: Row<PluginSidebarThread>,
  ) => { name: string; hue: number } | null;
  now: number;
  showAge: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, UP_NEXT_LIMIT);
  const more = rows.length - UP_NEXT_LIMIT;
  const marks = shown.some((row) =>
    hasStatusMark(row.thread, work(row.thread), true),
  );
  return (
    <section aria-label="Up Next" className="ws-home-up-next ws-needs">
      <h2 className="ws-home-up-next-head">
        <span>Up Next</span>
        {focused ? (
          <span
            role="img"
            aria-label="Showing prioritized workstreams"
            className="ws-home-flag"
          >
            <PriorityIcon className="ws-home-flag-icon" />
          </span>
        ) : null}
        {rows.length > 1 ? (
          <span className="ws-needs-count">
            <span aria-hidden="true">{rows.length}</span>
            <span className="sr-only">, {rows.length} threads</span>
          </span>
        ) : null}
      </h2>
      <ul className="ws-home-rows" role="list">
        {shown.map((row) => {
          const analysis = work(row.thread);
          return (
            <HomeRow
              key={row.thread.id}
              thread={row.thread}
              work={analysis}
              now={now}
              variant="attention"
              showMarkSlot={marks}
              showAge={showAge}
              workstream={workstreamOf(row)}
              ask={
                analysis.kind === "current" ? analysis.analysis.needsYou : null
              }
            />
          );
        })}
      </ul>
      {more > 0 ? (
        <button
          type="button"
          className="ws-home-more ws-amber-text"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show less" : `Show ${more} more`}
        </button>
      ) : null}
    </section>
  );
}
