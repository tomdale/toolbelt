/**
 * What a sidebar drop changes, worked out from the projection alone so the
 * list component only has to carry it out.
 */
import { arrayMove } from "@dnd-kit/sortable";
import {
  applyOrder,
  placeBefore,
  type ManualOrder,
} from "../../domain/order.ts";
import {
  type Projection,
  type Section,
  type WorkstreamThread,
} from "../../domain/project.ts";
import type { ReorderChange } from "../useWorkstreams.ts";
import type { Drop } from "./dnd.tsx";

/**
 * What a sidebar drop changes: only the order. A thread's workstream follows
 * its topic, so dragging a thread into another group doesn't move it there.
 */
export type DropPlan = {
  reorder: ReorderChange | null;
};

export function planDrop<T extends WorkstreamThread>(
  drop: Drop,
  projection: Projection<T>,
  sections: readonly Section[],
  order: ManualOrder,
): DropPlan {
  if (drop.kind === "group") {
    const ids = applyOrder(
      sections,
      order.workstreams,
      (s) => s.id,
      "last",
    ).map((s) => s.id);
    const from = ids.indexOf(drop.groupId);
    const to = ids.indexOf(drop.overGroupId);
    if (from < 0 || to < 0 || from === to) return { reorder: null };
    return {
      reorder: { kind: "workstreams", ids: arrayMove(ids, from, to) },
    };
  }

  if (drop.fromGroupId !== drop.toGroupId) {
    // Cross-group moving is disabled; navigation is derived by coordinator.
    return { reorder: null };
  }

  const group = [
    ...projection.groups,
    projection.unsorted,
    ...projection.dormant,
  ].find((g) => g.id === drop.toGroupId);
  const roots = (group?.rows ?? [])
    .filter((row) => row.depth === 0)
    .map((row) => row.thread.id);
  let ids: string[];
  if (drop.overThreadId === null) {
    // Dropped on a group header: the top of that group.
    ids = placeBefore(roots, drop.threadId, roots[0] ?? null);
  } else {
    // Matches the live preview, where the dragged tree takes the target's slot.
    ids = arrayMove(
      roots,
      roots.indexOf(drop.threadId),
      roots.indexOf(drop.overThreadId),
    );
  }
  return {
    reorder: { kind: "threads", groupId: drop.toGroupId, ids },
  };
}
