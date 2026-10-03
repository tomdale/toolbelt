import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { TaskIdentity } from "../task/TaskIdentity.tsx";

/**
 * Thread header action that displays the task's compact Product/Feature identity path
 * and provides independent assignment, clearing, and reclassification actions.
 */
export function TaskIdentityHeader({
  threadId,
  isCompactViewport = false,
}: PluginThreadHeaderActionProps) {
  return (
    <TaskIdentity threadId={threadId} isCompactViewport={isCompactViewport} />
  );
}
