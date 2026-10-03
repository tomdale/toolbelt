import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { useGoalContext } from "../goalContext.ts";
import { useGoalHeadingCollapsed } from "../stickyGoalState.ts";
import { WorkstreamIcon } from "../WorkstreamIcon.tsx";

/**
 * The thread's workstream and goal in the title bar. It appears when the
 * in-pane heading has scrolled out of view (see StickyGoalHeader), so the
 * thread's identity stays on screen without a banner over the timeline.
 */
export function GoalTitleChip({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const context = useGoalContext(threadId);
  const visible = useGoalHeadingCollapsed(threadId);
  if (isCompactViewport || !context) return null;
  return (
    <div
      className="ws-goal-chip"
      data-visible={visible}
      aria-hidden={!visible}
      title={context.goal}
      style={{ "--ws-hue": context.workstream?.hue } as React.CSSProperties}
    >
      {context.workstream && (
        <span className="ws-goal-chip__workstream">
          <WorkstreamIcon className="size-4 text-current" />
          {context.workstream.name}
        </span>
      )}
      <span className="ws-goal-chip__goal">{context.goal}</span>
    </div>
  );
}
