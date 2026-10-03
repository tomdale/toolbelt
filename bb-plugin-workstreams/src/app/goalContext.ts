import { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
import { workstreamHue } from "../domain/workstreamHue.ts";
import { useSharedServerState } from "./serverState.ts";

export type GoalContext = {
  /**
   * The thread's name, exactly as the sidebar and every other list show it.
   * Workstreams writes the thread's goal as its title; a title the user or an
   * agent chose stays, and an untitled thread shows BB's placeholder.
   */
  title: string;
  /** The current recap's goal, when it adds to the thread's title. */
  subtask: string | null;
  /** The thread's workstream with its identity hue, or null when unfiled. */
  workstream: { name: string; hue: number } | null;
};

/** What a thread is for: its title, current subtask, and workstream. */
export function useGoalContext(threadId: string | null): GoalContext | null {
  const { threads, sections } = experimental_useSidebarThreads();
  const { server } = useSharedServerState();
  return useMemo(() => {
    if (!threadId) return null;
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return null;
    const title = thread.displayTitle;
    const recapGoal = server.recaps[threadId]?.goal;
    const section = thread.sectionId
      ? sections.find((item) => item.id === thread.sectionId)
      : null;
    return {
      title,
      subtask: recapGoal && recapGoal !== title ? recapGoal : null,
      workstream: section
        ? { name: section.name, hue: workstreamHue(section.id) }
        : null,
    };
  }, [threadId, threads, sections, server.recaps]);
}
