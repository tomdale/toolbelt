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
  UNSORTED_ID,
  type Projection,
  type Section,
  type WorkstreamThread,
} from "../../domain/project.ts";
import type { ReorderChange } from "../useWorkstreams.ts";
import type { Drop } from "./dnd.tsx";

export type DropPlan = {
  /** A root filed into another workstream (null section = Unsorted). */
  move: { threadId: string; sectionId: string | null } | null;
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
    if (from < 0 || to < 0 || from === to) return { move: null, reorder: null };
    return {
      move: null,
      reorder: { kind: "workstreams", ids: arrayMove(ids, from, to) },
    };
  }

  const group = [
    ...projection.groups,
    projection.unsorted,
    ...projection.dormant,
  ].find((g) => g.id === drop.toGroupId);
  const roots = (group?.rows ?? [])
    .filter((row) => row.depth === 0)
    .map((row) => row.thread.id);
  const moved = drop.fromGroupId !== drop.toGroupId;
  let ids: string[];
  if (drop.overThreadId === null) {
    // Dropped on a group header: the top of that group.
    ids = placeBefore(roots, drop.threadId, roots[0] ?? null);
  } else if (!moved) {
    // Matches the live preview, where the dragged tree takes the target's slot.
    ids = arrayMove(
      roots,
      roots.indexOf(drop.threadId),
      roots.indexOf(drop.overThreadId),
    );
  } else {
    const at = roots.indexOf(drop.overThreadId);
    ids = placeBefore(
      roots,
      drop.threadId,
      drop.below ? (roots[at + 1] ?? null) : drop.overThreadId,
    );
  }
  return {
    move: moved
      ? {
          threadId: drop.threadId,
          sectionId: drop.toGroupId === UNSORTED_ID ? null : drop.toGroupId,
        }
      : null,
    reorder: { kind: "threads", groupId: drop.toGroupId, ids },
  };
}
