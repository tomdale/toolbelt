import { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
import { workstreamHue } from "../domain/workstreamHue.ts";
import { useSharedServerState } from "./serverState.ts";

export type GoalContext = {
  goal: string;
  /** The current recap's goal, when it adds to the thread goal. */
  subtask: string | null;
  /** The thread's workstream with its identity hue, or null when unfiled. */
  workstream: { name: string; hue: number } | null;
};

/** What a thread is for: its goal, current subtask, and workstream. */
export function useGoalContext(threadId: string | null): GoalContext | null {
  const { threads, sections } = experimental_useSidebarThreads();
  const { server } = useSharedServerState();
  return useMemo(() => {
    if (!threadId) return null;
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return null;
    const goal =
      server.analysis[threadId]?.goal ??
      (thread.title ? thread.displayTitle : "Building a clear thread goal");
    const recapGoal = server.recaps[threadId]?.goal;
    const section = thread.sectionId
      ? sections.find((item) => item.id === thread.sectionId)
      : null;
    return {
      goal,
      subtask: recapGoal && recapGoal !== goal ? recapGoal : null,
      workstream: section
        ? { name: section.name, hue: workstreamHue(section.id) }
        : null,
    };
  }, [threadId, threads, sections, server.analysis, server.recaps]);
}
