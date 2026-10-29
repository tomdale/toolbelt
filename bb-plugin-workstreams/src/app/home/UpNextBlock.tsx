import { useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Row } from "../../domain/project.ts";
import type { WorkView } from "../useWorkstreams.ts";
import { hasStatusMark } from "../sidebar/Row.tsx";
import { FocusIcon } from "../sidebar/FocusIcon.tsx";
import { HomeRow } from "./HomeRow.tsx";

/**
 * Up Next on Home: the rows `selectUpNext` chose, in the sidebar's amber
 * block, with Show more for the trimmed threads still unread or blocked on
 * the user. Each row names its workstream in the workstream's hue.
 */
export function UpNextBlock({
  rows: kept,
  more,
  focused,
  work,
  workstreamOf,
  now,
  showAge,
}: {
  rows: readonly Row<PluginSidebarThread>[];
  /** What Show more reveals below `rows`. */
  more: readonly Row<PluginSidebarThread>[];
  /** Focus left other workstreams' threads out. */
  focused: boolean;
  work: (thread: PluginSidebarThread) => WorkView;
  workstreamOf: (
    row: Row<PluginSidebarThread>,
  ) => { name: string; hue: number } | null;
  now: number;
  showAge: boolean;
}) {
  const [showMore, setShowMore] = useState(false);
  // With nothing left to reveal Show more closes, so the next reveal starts
  // collapsed, as in the sidebar.
  if (showMore && more.length === 0) setShowMore(false);
  const rows = showMore ? [...kept, ...more] : kept;
  const marks = rows.some((row) =>
    hasStatusMark(row.thread, work(row.thread), true),
  );
  return (
    <section aria-label="Up Next" className="ws-home-up-next ws-needs">
      <h2 className="ws-home-up-next-head">
        <span>Up Next</span>
        {focused ? (
          <span
            role="img"
            aria-label="Showing focused workstreams"
            className="ws-home-flag"
          >
            <FocusIcon className="ws-home-flag-icon" />
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
        {rows.map((row) => {
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
      {more.length > 0 ? (
        <button
          type="button"
          className="ws-home-more ws-amber-text"
          aria-expanded={showMore}
          onClick={() => setShowMore(!showMore)}
        >
          {showMore ? "Show less" : `Show ${more.length} more`}
        </button>
      ) : null}
    </section>
  );
}
