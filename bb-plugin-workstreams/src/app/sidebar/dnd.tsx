/**
 * Drag and drop for the sidebar: workstream headers reorder workstreams, and
 * a root thread's row reorders its whole tree within a group or drops it into
 * another group (a move). Children follow their root and never drag alone.
 *
 * Drags use mouse and touch sensors rather than pointer events so BB's
 * split drag, which starts from the row anchor's pointerdown and engages only
 * once the pointer leaves the sidebar, keeps working alongside.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DndContextProps,
  type DragEndEvent,
  type DragOverEvent,
  type DraggableSyntheticListeners,
  type Modifier,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/** What each draggable or droppable is. `groupId` is a section id or "unsorted". */
export type DragData =
  /** `pinned`: a prioritized workstream, which reorders only among its tier. */
  | { type: "group"; groupId: string; pinned?: boolean }
  | { type: "thread"; threadId: string; groupId: string }
  /** A group that takes thread drops but does not itself reorder (Unfiled). */
  | { type: "target"; groupId: string };

export type Drop =
  | { kind: "group"; groupId: string; overGroupId: string }
  | {
      kind: "thread";
      threadId: string;
      fromGroupId: string;
      toGroupId: string;
      /** The root the dragged tree lands on; null for a group header. */
      overThreadId: string | null;
      /** Whether the dragged tree ended below the middle of `overThreadId`. */
      below: boolean;
    };

const dataOf = (value: unknown) => value as DragData | undefined;

/**
 * Threads land on rows first, then on a group; workstreams land only on
 * workstreams in their own tier (prioritized or not). Only what is under the
 * pointer counts, so releasing over a band or outside the list changes
 * nothing.
 */
const collision: CollisionDetection = (args) => {
  const active = dataOf(args.active.data.current);
  const activeType = active?.type;
  const accepts = (data: DragData | undefined) =>
    activeType === "group"
      ? data?.type === "group" &&
        !!data.pinned === (active?.type === "group" && !!active.pinned)
      : data !== undefined;
  const hits = pointerWithin({
    ...args,
    droppableContainers: args.droppableContainers.filter((container) =>
      accepts(dataOf(container.data.current)),
    ),
  });
  if (activeType !== "thread") return hits;
  const rows = hits.filter(
    (hit) =>
      dataOf(hit.data?.droppableContainer?.data.current)?.type === "thread",
  );
  return rows.length ? rows : hits;
};

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * DndContext props for the list, plus the group a thread drag would move
 * into (for highlighting). `containerRef` bounds the list: a drop outside it
 * sideways belongs to BB's split drag, not a reorder.
 */
export function useSidebarDnd({
  containerRef,
  onDrop,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onDrop: (drop: Drop) => void;
}): { contextProps: DndContextProps; dropGroupId: string | null } {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 6 },
    }),
  );
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const suppressClick = useClickSuppression();

  const onDragOver = useCallback((event: DragOverEvent) => {
    const active = dataOf(event.active.data.current);
    const over = dataOf(event.over?.data.current);
    setDropGroupId(
      active?.type === "thread" && over && over.groupId !== active.groupId
        ? over.groupId
        : null,
    );
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDropGroupId(null);
      suppressClick.end();
      const active = dataOf(event.active.data.current);
      const over = dataOf(event.over?.data.current);
      if (!active || !over || event.active.id === event.over?.id) return;
      const start = event.activatorEvent as MouseEvent | TouchEvent;
      const point = "touches" in start ? start.touches[0] : start;
      const bounds = containerRef.current?.getBoundingClientRect();
      if (point && bounds) {
        const x = point.clientX + event.delta.x;
        if (x < bounds.left || x > bounds.right) return;
      }
      if (active.type === "group") {
        if (over.type === "group")
          onDrop({
            kind: "group",
            groupId: active.groupId,
            overGroupId: over.groupId,
          });
        return;
      }
      if (active.type !== "thread") return;
      const dragged = event.active.rect.current.translated;
      const target = event.over!.rect;
      onDrop({
        kind: "thread",
        threadId: active.threadId,
        fromGroupId: active.groupId,
        toGroupId: over.groupId,
        overThreadId: over.type === "thread" ? over.threadId : null,
        below: dragged
          ? dragged.top + dragged.height / 2 > target.top + target.height / 2
          : false,
      });
    },
    [containerRef, onDrop, suppressClick],
  );

  return {
    dropGroupId,
    contextProps: {
      sensors,
      collisionDetection: collision,
      modifiers: [verticalOnly],
      onDragStart: suppressClick.begin,
      onDragOver,
      onDragEnd,
      onDragCancel: () => {
        setDropGroupId(null);
        suppressClick.end();
      },
    },
  };
}

/**
 * Swallows the click that ends a drag, before it reaches the row anchor and
 * opens the thread. Listens on window in the capture phase, ahead of the
 * document-level listener the sensor adds, which only stops propagation and
 * would let the anchor's default navigation through.
 */
function useClickSuppression() {
  const listener = useRef<((event: MouseEvent) => void) | null>(null);
  const remove = useCallback(() => {
    if (listener.current)
      window.removeEventListener("click", listener.current, true);
    listener.current = null;
  }, []);
  useEffect(() => remove, [remove]);
  const begin = useCallback(() => {
    remove();
    listener.current = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("click", listener.current, true);
  }, [remove]);
  // The click follows the mouseup that ends the drag in the same task.
  const end = useCallback(() => void setTimeout(remove, 0), [remove]);
  return useMemo(() => ({ begin, end }), [begin, end]);
}

/** Props that make an element the drag handle for its sortable item. */
export type DragHandle = {
  ref: (element: HTMLElement | null) => void;
  listeners: DraggableSyntheticListeners;
};

/**
 * One reorderable item. Only listeners go on the handle: the keyboard
 * sortable attributes would turn a row that already holds a link into a
 * nested button.
 */
export function Sortable({
  id,
  data,
  disabled = false,
  children,
}: {
  id: string;
  data: DragData;
  disabled?: boolean;
  children: (binding: {
    ref: (element: HTMLElement | null) => void;
    style: CSSProperties;
    handle: DragHandle;
    isDragging: boolean;
  }) => ReactNode;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, data, disabled });
  return children({
    ref: setNodeRef,
    style: {
      transform: CSS.Translate.toString(transform),
      transition,
      ...(isDragging && {
        position: "relative",
        zIndex: 10,
        borderRadius: 6,
        background: "var(--sidebar, var(--background))",
        boxShadow: "0 4px 12px rgb(0 0 0 / 0.25)",
      }),
    },
    handle: { ref: setActivatorNodeRef, listeners },
    isDragging,
  });
}

/** A group that accepts thread drops without reordering itself. */
export function DropTarget({
  id,
  data,
  children,
}: {
  id: string;
  data: DragData;
  children: (ref: (element: HTMLElement | null) => void) => ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id, data });
  return children(setNodeRef);
}
