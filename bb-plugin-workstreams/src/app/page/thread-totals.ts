/**
 * Live task-root and child-thread totals from BB's sidebar list. Organize
 * reports roots and the child threads that follow them separately, since a
 * tree's workstream is its root's section (SPEC I2).
 */
import { useMemo } from "react";
import { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { buildForest, flatten } from "../../domain/tree.ts";

export type ThreadTotals = {
  ready: boolean;
  /** Visible, non-archived task roots. */
  tasks: number;
  /** Visible, non-archived descendants of those roots. */
  childThreads: number;
  childrenOf: (rootId: string) => number;
  /** Task roots and child threads per section; null is Unfiled. */
  inSection: (sectionId: string | null) => { tasks: number; children: number };
};

export function useThreadTotals(): ThreadTotals {
  const { status, threads } = experimental_useSidebarThreads();
  return useMemo(() => {
    const live = threads.filter((t) => !t.isArchived && !t.isHidden);
    const { roots } = buildForest(live);
    const children = new Map<string, number>();
    const sections = new Map<
      string | null,
      { tasks: number; children: number }
    >();
    let childThreads = 0;
    for (const root of roots) {
      const count = flatten(root).length - 1;
      children.set(root.thread.id, count);
      childThreads += count;
      const key = root.thread.sectionId ?? null;
      const totals = sections.get(key) ?? { tasks: 0, children: 0 };
      sections.set(key, {
        tasks: totals.tasks + 1,
        children: totals.children + count,
      });
    }
    return {
      ready: status === "ready",
      tasks: roots.length,
      childThreads,
      childrenOf: (id) => children.get(id) ?? 0,
      inSection: (id) => sections.get(id) ?? { tasks: 0, children: 0 },
    };
  }, [status, threads]);
}
