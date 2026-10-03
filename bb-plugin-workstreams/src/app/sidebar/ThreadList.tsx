/**
 * The Workstreams sidebar thread list: the Up Next section, the prioritized
 * workstreams, and the Recent band, then one group per remaining workstream
 * (BB section, in the user's drag-and-drop order, else BB's), Unfiled, a
 * Dormant fold, and a Snoozed fold. Up Next and Recent are overlays: every
 * visible thread appears in exactly one group, or in Snoozed (SPEC I1).
 *
 * While a prioritized workstream has a thread in Up Next, Up Next shows only
 * prioritized threads (see `focusNeeds`), and while any workstream is
 * prioritized, the rest hide behind a toggle below the prioritized ones. Changes the user didn't make never
 * pull the open thread's row away, and rows open and close rather than pop
 * (see `motion.ts`).
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useBbNavigate,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  UNFILED_NAME,
  type Group,
  type Row as RowModel,
} from "../../domain/project.ts";
import { arrangeGroups } from "../../domain/groups.ts";
import { UP_NEXT_LIMIT, selectUpNext } from "../../domain/upNext.ts";
import { useWorkstreams } from "../useWorkstreams.ts";
import { useCollapsed } from "./useCollapsed.ts";
import {
  BAND_OPTIONS_KEY,
  readBandOptions,
  type BandId,
  type BandOptions,
  type BandSort,
  type BandSortOption,
} from "./useBandOptions.ts";
import { NameDialog, type NameRequest } from "./NameDialog.tsx";
import { Row, hasStatusMark } from "./Row.tsx";
import { RowMenu, type RowMenuHandlers } from "./RowMenu.tsx";
import { GroupMenu } from "./GroupMenu.tsx";
import { NewWorkDialog } from "../composer/NewWork.tsx";
import { TraceInspector } from "../debug/Inspector.tsx";
import {
  DropTarget,
  Sortable,
  useSidebarDnd,
  type DragHandle,
  type Drop,
} from "./dnd.tsx";
import { planDrop } from "./drop.ts";
import { describeWake, shortWake, wakeTime } from "../../domain/snooze.ts";
import { snoozeThread, wakeThread } from "../snooze/actions.ts";
import { CustomSnoozeDialog } from "../snooze/CustomSnoozeDialog.tsx";
import { SnoozeMenuItems, plainMenuKit } from "../snooze/SnoozeMenuItems.tsx";
import { WorkstreamName } from "../WorkstreamName.tsx";
import {
  presenceProps,
  useFlip,
  usePresence,
  type PresenceEntry,
} from "./motion.ts";
import { PriorityIcon } from "./PriorityIcon.tsx";
import { usePrefs } from "../prefs.ts";

type ThreadGroup = Group<PluginSidebarThread>;
type ThreadRow = RowModel<PluginSidebarThread>;
/** Where a row is drawn: its workstream group, or one of the overlays. */
type Placement = "group" | "needs-you" | "recent" | "snoozed" | "archived";

const groupKey = (id: string) => `ws:${id}`;
const treeKey = (id: string) => `t:${id}`;

/** Each row's descendants, in tree order, across these tree-ordered lists. */
function descendantsOf(
  lists: readonly (readonly ThreadRow[])[],
): Map<string, ThreadRow[]> {
  const out = new Map<string, ThreadRow[]>();
  for (const rows of lists)
    rows.forEach((row, index) => {
      const below: ThreadRow[] = [];
      for (const next of rows.slice(index + 1)) {
        if (next.depth <= row.depth) break;
        below.push(next);
      }
      if (below.length > 0) out.set(row.thread.id, below);
    });
  return out;
}

/**
 * Collapse-state key for a parent row. Overlay copies of a thread fold
 * independently of its place in its group.
 */
const foldKey = (placement: Placement, id: string) =>
  placement === "group" ? `thread:${id}` : `${placement}:thread:${id}`;
/**
 * Parents start expanded where they are drawn as trees (groups, Snoozed)
 * and collapsed in the Up Next and Recent overlays.
 */
const foldDefault = (placement: Placement) =>
  placement === "needs-you" || placement === "recent";
/** Overlays draw a row flat, with its children only when expanded. */
const isOverlay = foldDefault;

/** A group's rows split into trees, each led by its root. */
function treesOf(rows: readonly ThreadRow[]): ThreadRow[][] {
  const trees: ThreadRow[][] = [];
  for (const row of rows)
    if (row.depth === 0 || trees.length === 0) trees.push([row]);
    else trees.at(-1)!.push(row);
  return trees;
}

function compareBandRows(
  a: ThreadRow,
  b: ThreadRow,
  sort: BandSort,
  snoozeOf: (
    thread: PluginSidebarThread,
  ) => { until: number | null } | undefined,
): number {
  if (sort === "title")
    return a.thread.displayTitle.localeCompare(b.thread.displayTitle);
  if (sort === "wake") {
    const wake = (row: ThreadRow) =>
      snoozeOf(row.thread)?.until ?? Number.POSITIVE_INFINITY;
    return wake(a) - wake(b);
  }
  if (sort === "archived")
    return (b.thread.archivedAt ?? 0) - (a.thread.archivedAt ?? 0);
  return b.thread.latestAttentionAt - a.thread.latestAttentionAt;
}

function sortedBandRows(
  rows: readonly ThreadRow[],
  sort: BandSort,
  snoozeOf: (
    thread: PluginSidebarThread,
  ) => { until: number | null } | undefined,
): ThreadRow[] {
  return [...rows].sort(
    (a, b) =>
      compareBandRows(a, b, sort, snoozeOf) ||
      a.thread.id.localeCompare(b.thread.id),
  );
}

export function WorkstreamsThreadList({
  activeThreadId,
  onNavigate,
}: PluginThreadListProps) {
  const ws = useWorkstreams();
  const { prefs, save: savePrefs } = usePrefs();
  const archived = experimental_useSidebarThreads({
    experimental_lifecycles: ws.showArchived ? ["archived"] : [],
  });
  const actions = experimental_useSidebarThreadActions();
  const navigate = useBbNavigate();
  const { isCollapsed, toggle } = useCollapsed();
  const [bandOptions, setBandOptions] = useState(readBandOptions);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        BAND_OPTIONS_KEY,
        JSON.stringify(bandOptions),
      );
    } catch {
      // Section preferences are a convenience; losing them is harmless.
    }
  }, [bandOptions]);
  const updateBandOptions = (
    section: BandId,
    change: Partial<BandOptions[BandId]>,
  ) =>
    setBandOptions((current) => ({
      ...current,
      [section]: { ...current[section], ...change },
    }));
  const [nameRequest, setNameRequest] = useState<NameRequest | null>(null);
  const [newWork, setNewWork] = useState<{
    workstreamId: string | null;
    workstreamName?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAllNeeds, setShowAllNeeds] = useState(false);
  const [showLower, setShowLower] = useState(false);
  // Lower-priority workstreams the user expanded since revealing them. Not
  // persisted: each reveal starts with every one collapsed.
  const [lowerExpanded, setLowerExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [inspecting, setInspecting] = useState<PluginSidebarThread | null>(
    null,
  );
  const [customSnooze, setCustomSnooze] = useState<PluginSidebarThread | null>(
    null,
  );
  const { projection, sections, now } = ws;
  const previousNeedsYou = useRef(projection.needsYou);
  useEffect(() => {
    previousNeedsYou.current = projection.needsYou;
  }, [projection.needsYou]);
  const [forYouSelection, setForYouSelection] = useState({
    threadId: activeThreadId,
    index: -1,
  });
  const selectedIndex = projection.needsYou.findIndex(
    (row) => row.thread.id === activeThreadId,
  );
  const selection =
    forYouSelection.threadId !== activeThreadId
      ? {
          threadId: activeThreadId,
          index:
            selectedIndex >= 0
              ? selectedIndex
              : previousNeedsYou.current.findIndex(
                  (row) => row.thread.id === activeThreadId,
                ),
        }
      : forYouSelection.index < 0 && selectedIndex >= 0
        ? { ...forYouSelection, index: selectedIndex }
        : forYouSelection;
  if (selection !== forYouSelection) setForYouSelection(selection);

  // Keep a selected Up Next row in place after read/status updates. Resolve
  // it from live groups so its contents stay current; snoozed, hidden, and
  // archived threads still leave the list when explicitly put away.
  const forYouRows = [...projection.needsYou];
  if (selection.index >= 0 && selectedIndex < 0) {
    const selectedRow = [
      ...projection.groups,
      projection.unsorted,
      ...projection.dormant,
    ]
      .flatMap((group) => group.rows)
      .find((row) => row.thread.id === activeThreadId);
    if (selectedRow) forYouRows.splice(selection.index, 0, selectedRow);
  }
  const nameOf = new Map(sections.map((s) => [s.id, s.name]));
  const prioritizedIds = ws.server.order.prioritized;
  const prioritized = new Set(prioritizedIds.filter((id) => nameOf.has(id)));

  // Focus Up Next on the prioritized workstreams. The open thread keeps its
  // row if Up Next was showing it, so a prioritized thread arriving never
  // takes the row out from under the user; it leaves once they move on.
  const shownBefore = useRef<ReadonlySet<string>>(new Set());
  const {
    focus,
    recapRows,
    rows: shownNeedsRows,
  } = selectUpNext(projection, {
    needsYou: forYouRows,
    recaps: ws.server.recaps,
    prioritized,
    keep: (row) =>
      row.thread.id === activeThreadId &&
      shownBefore.current.has(row.thread.id),
  });
  const recentRows = projection.recent.filter(
    (row) =>
      !forYouRows.some((kept) => kept.thread.id === row.thread.id) &&
      !recapRows.some((kept) => kept.thread.id === row.thread.id),
  );
  useLayoutEffect(() => {
    shownBefore.current = new Set(focus.shown.map((row) => row.thread.id));
  });
  const archivedThreads = ws.showArchived
    ? archived.threads.filter((thread) => thread.isArchived && !thread.isHidden)
    : [];
  const archivedById = new Map(
    archivedThreads.map((thread) => [thread.id, thread]),
  );
  const archivedWorkstreamOf = (thread: PluginSidebarThread) => {
    let root = thread;
    const seen = new Set([thread.id]);
    while (root.parentThreadId && !seen.has(root.parentThreadId)) {
      const parent = archivedById.get(root.parentThreadId);
      if (!parent) break;
      seen.add(parent.id);
      root = parent;
    }
    return root.sectionId;
  };
  const archivedRows: ThreadRow[] = archivedThreads.map((thread) => ({
    thread,
    depth: 0,
    hasChildren: false,
    workstreamId: archivedWorkstreamOf(thread),
    needsYou: false,
  }));
  const archivedGroups = sections
    .map((section) => ({
      id: section.id,
      name: section.name,
      threads: archivedThreads.filter(
        (thread) => archivedWorkstreamOf(thread) === section.id,
      ),
    }))
    .filter((group) => group.threads.length > 0);
  const unsortedArchived = archivedThreads.filter((thread) => {
    const sectionId = archivedWorkstreamOf(thread);
    return !sectionId || !nameOf.has(sectionId);
  });

  const descendants = descendantsOf([
    ...[...projection.groups, projection.unsorted, ...projection.dormant].map(
      (group) => group.rows,
    ),
    projection.snoozed,
  ]);
  const folded = (placement: Placement, id: string) =>
    isCollapsed(foldKey(placement, id), foldDefault(placement));
  /** Drops rows beneath a folded ancestor; `rows` must be in tree order. */
  const unfolded = (rows: readonly ThreadRow[], placement: Placement) => {
    const out: ThreadRow[] = [];
    let hideBelow: number | null = null;
    for (const row of rows) {
      if (hideBelow !== null && row.depth > hideBelow) continue;
      hideBelow = null;
      out.push(row);
      if (descendants.has(row.thread.id) && folded(placement, row.thread.id))
        hideBelow = row.depth;
    }
    return out;
  };

  const listRef = useRef<HTMLDivElement>(null);
  const captureLayout = useFlip(listRef, [...prioritized].sort().join(" "));
  const togglePriority = (group: ThreadGroup) => {
    setError(null);
    captureLayout(`group:${group.id}`);
    const ids = group.prioritized
      ? prioritizedIds.filter((id) => id !== group.id)
      : [...prioritizedIds, group.id];
    ws.reorder({ kind: "prioritized", ids }).catch(report);
  };

  const report = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  const onDrop = (drop: Drop) => {
    setError(null);
    const plan = planDrop(drop, projection, sections, ws.server.order);
    if (plan.move)
      ws.moveThread(plan.move.threadId, plan.move.sectionId).catch(report);
    if (plan.reorder) ws.reorder(plan.reorder).catch(report);
  };
  const { contextProps, dropGroupId } = useSidebarDnd({
    containerRef: listRef,
    onDrop,
  });

  const handlers: RowMenuHandlers = {
    move: (thread, sectionId) => {
      setError(null);
      ws.moveThread(thread.id, sectionId).catch(report);
    },
    newWorkstream: (thread) =>
      setNameRequest({
        title: "New workstream",
        initial: "",
        submitLabel: "Create and move",
        onSubmit: async (name) => {
          await ws.rpc.call("createWorkstream", { name, threadId: thread.id });
        },
      }),
    rename: (thread) =>
      setNameRequest({
        title: "Rename thread",
        initial: thread.title ?? thread.displayTitle,
        submitLabel: "Rename",
        onSubmit: (name) => actions.rename(thread.id, name),
      }),
    openParent: (thread) => {
      if (thread.parentThreadId) {
        navigate.toThread(thread.parentThreadId);
        onNavigate();
      }
    },
    inspect: (thread) => setInspecting(thread),
    snooze: (thread, until) =>
      snoozeThread(ws.setSnooze, thread, until, ws.snoozeOf(thread)),
    customSnooze: (thread) => setCustomSnooze(thread),
    wake: (thread) => wakeThread(ws.setSnooze, thread),
  };
  const snoozePrefs = ws.snoozePrefs;
  const defaultSnoozeTitle = `Snooze ${describeWake(wakeTime(snoozePrefs.default, now, snoozePrefs.morningHour), now)}`;
  const renameWorkstream = (group: ThreadGroup) =>
    setNameRequest({
      title: "Rename workstream",
      initial: group.name,
      submitLabel: "Rename",
      onSubmit: async (name) => {
        await ws.rpc.call("renameWorkstream", { sectionId: group.id, name });
      },
    });

  /** An unfiled row has no workstream to name, so it shows its age instead. */
  const workstreamName = (row: ThreadRow) =>
    row.workstreamId ? nameOf.get(row.workstreamId) : undefined;
  /** What an Up Next thread asks of Tom, from its current analysis. */
  const askOf = (row: ThreadRow) => {
    const work = ws.work(row.thread);
    return work?.kind === "current" ? work.analysis.needsYou : null;
  };
  /** Whether any of these rows draws a status mark (see `hasStatusMark`). */
  const anyMark = (rows: readonly ThreadRow[], placement: Placement) =>
    rows.some(
      (row) =>
        descendants.has(row.thread.id) ||
        hasStatusMark(
          row.thread,
          ws.work(row.thread),
          placement === "needs-you",
        ),
    );
  // The open thread's row stays visible when newer rows push it past the
  // limit.
  const needsRows = showAllNeeds
    ? shownNeedsRows
    : shownNeedsRows.filter(
        (row, index) =>
          index < NEEDS_YOU_LIMIT || row.thread.id === activeThreadId,
      );
  const moreNeeds = shownNeedsRows.length - needsRows.length;
  const needsMarks = anyMark(needsRows, "needs-you");
  const rowKey = (row: ThreadRow) => row.thread.id;
  const showBand = ws.showForYou && shownNeedsRows.length > 0;
  const bandPresence = usePresence(showBand ? ["band"] : [], String);
  const needsPresence = usePresence(needsRows, rowKey);
  const needsControls = usePresence(
    (showAllNeeds ? shownNeedsRows.length > NEEDS_YOU_LIMIT : moreNeeds > 0)
      ? ["more"]
      : [],
    String,
  );
  /**
   * The row's hover snooze button and the menu beside it. In Snoozed, a
   * thread with its own snooze wakes; a descendant that is only there with
   * its parent has none.
   */
  const snoozeActionOf = (row: ThreadRow, placement: Placement) => {
    const snooze = ws.snoozeOf(row.thread);
    if (placement === "archived") return undefined;
    if (placement === "snoozed" && !snooze) return undefined;
    const menu = (
      <SnoozeMenuItems
        kit={plainMenuKit}
        now={now}
        preset={snoozePrefs.default}
        morningHour={snoozePrefs.morningHour}
        only={snoozePrefs.quick}
        snooze={snooze}
        onSnooze={(until) => handlers.snooze(row.thread, until)}
        onWake={() => handlers.wake(row.thread)}
        onPick={() => handlers.customSnooze(row.thread)}
      />
    );
    if (placement !== "snoozed")
      return {
        kind: "snooze" as const,
        title: defaultSnoozeTitle,
        run: () =>
          handlers.snooze(
            row.thread,
            wakeTime(snoozePrefs.default, Date.now(), snoozePrefs.morningHour),
          ),
        menu,
      };
    return {
      kind: "wake" as const,
      title: `Wake now (snoozed ${describeWake(snooze!.until, now)})`,
      run: () => handlers.wake(row.thread),
      menu,
    };
  };
  const contextOf = (row: ThreadRow, placement: Placement) => {
    if (placement === "group") return undefined;
    if (placement !== "snoozed") return workstreamName(row);
    const snooze = ws.snoozeOf(row.thread);
    return snooze ? shortWake(snooze.until, now) : undefined;
  };
  /**
   * Whether the row leads its tree, so it can move between workstreams.
   * Snoozed rows restart their depth at the snoozed thread, so there it's
   * whether the thread's parent is in the list at all.
   */
  const isRoot = (row: ThreadRow, placement: Placement) =>
    placement === "snoozed"
      ? !row.thread.parentThreadId ||
        !projection.rowOf.has(row.thread.parentThreadId)
      : row.depth === 0;
  const renderRow = (
    row: ThreadRow,
    placement: Placement,
    handle?: DragHandle,
    showStatusSlot = true,
    depth = isOverlay(placement) ? 0 : row.depth,
    key = row.thread.id,
  ) => (
    <RowMenu
      key={key}
      thread={row.thread}
      isRoot={isRoot(row, placement)}
      workstreamId={row.workstreamId}
      sections={sections}
      handlers={handlers}
      snooze={ws.snoozeOf(row.thread)}
      morningHour={snoozePrefs.morningHour}
      showArchive={placement !== "archived"}
    >
      <li ref={handle?.ref} {...handle?.listeners} className="list-none">
        <Row
          thread={row.thread}
          depth={depth}
          active={row.thread.id === activeThreadId}
          now={now}
          context={contextOf(row, placement)}
          attention={placement === "needs-you"}
          work={ws.work(row.thread)}
          showStatusSlot={showStatusSlot}
          subtitle={placement === "needs-you" ? askOf(row) : null}
          snoozeAction={snoozeActionOf(row, placement)}
          showArchive={placement !== "archived"}
          disclosure={
            placement !== "recent" && descendants.has(row.thread.id)
              ? {
                  expanded: !folded(placement, row.thread.id),
                  toggle: () =>
                    toggle(
                      foldKey(placement, row.thread.id),
                      foldDefault(placement),
                    ),
                }
              : undefined
          }
          onNavigate={onNavigate}
        />
      </li>
    </RowMenu>
  );
  /**
   * An overlay row followed, when expanded, by its visible descendants,
   * indented relative to it.
   */
  const renderBandRows = (
    rows: readonly ThreadRow[],
    placement: "recent" | "snoozed" | "archived",
    section: BandId,
  ) => {
    const options = bandOptions[section];
    const marks = anyMark(rows, placement);
    const trees =
      placement === "snoozed" ? treesOf(rows) : rows.map((row) => [row]);
    const orderedTrees = [...trees].sort(
      (a, b) =>
        compareBandRows(a[0]!, b[0]!, options.sort, ws.snoozeOf) ||
        a[0]!.thread.id.localeCompare(b[0]!.thread.id),
    );
    const renderTrees = (items: readonly ThreadRow[][]) =>
      items.flatMap((tree) =>
        unfolded(tree, placement).map((row) =>
          renderRow(row, placement, undefined, marks),
        ),
      );
    if (!options.grouped) return renderTrees(orderedTrees);
    const groups = new Map<string | null, ThreadRow[][]>();
    for (const tree of orderedTrees) {
      const id = tree[0]!.workstreamId;
      const group = groups.get(id) ?? [];
      group.push(tree);
      groups.set(id, group);
    }
    return [...groups.entries()]
      .sort(([a], [b]) =>
        (a ? (nameOf.get(a) ?? UNFILED_NAME) : UNFILED_NAME).localeCompare(
          b ? (nameOf.get(b) ?? UNFILED_NAME) : UNFILED_NAME,
        ),
      )
      .map(([id, groupTrees]) => {
        const name = id ? (nameOf.get(id) ?? UNFILED_NAME) : UNFILED_NAME;
        return (
          <li key={`${placement}:${id ?? "unsorted"}`} className="list-none">
            <section
              aria-label={`${placement === "archived" ? "Archived " : `${placement[0]!.toUpperCase()}${placement.slice(1)} · `}${name}`}
              className="px-1"
            >
              <h3 className="px-1.5 py-0.5 text-[12px] font-medium text-muted-foreground">
                {name}
              </h3>
              <ul className="mt-0.5">{renderTrees(groupTrees)}</ul>
            </section>
          </li>
        );
      });
  };
  const renderOverlayTree = (
    row: ThreadRow,
    placement: Placement,
    marks: boolean,
  ) => [
    renderRow(row, placement, undefined, marks),
    ...(folded(placement, row.thread.id)
      ? []
      : unfolded(descendants.get(row.thread.id) ?? [], placement).map((child) =>
          renderRow(
            child,
            placement,
            undefined,
            marks,
            child.depth - row.depth,
            // A child can also be a row of its own in the same band.
            `${row.thread.id}/${child.thread.id}`,
          ),
        )),
  ];
  /** A group's rows as sortable trees; the root row drags the whole tree. */
  const renderTrees = (group: ThreadGroup) => {
    const marks = anyMark(group.rows, "group");
    return (
      <SortableContext
        items={treesOf(group.rows).map((tree) => treeKey(tree[0]!.thread.id))}
        strategy={verticalListSortingStrategy}
      >
        {treesOf(group.rows).map((tree) => {
          const root = tree[0]!.thread;
          return (
            <Sortable
              key={root.id}
              id={treeKey(root.id)}
              data={{ type: "thread", threadId: root.id, groupId: group.id }}
            >
              {({ ref, style, handle }) => (
                <li ref={ref} style={style} className="list-none">
                  <ul>
                    {unfolded(tree, "group").map((row, index) =>
                      renderRow(
                        row,
                        "group",
                        index === 0 ? handle : undefined,
                        marks,
                      ),
                    )}
                  </ul>
                </li>
              )}
            </Sortable>
          );
        })}
      </SortableContext>
    );
  };
  const renderSortableGroup = (
    group: ThreadGroup,
    props: Omit<GroupProps, "group" | "children">,
  ) => (
    <Sortable
      key={group.id}
      id={groupKey(group.id)}
      data={{ type: "group", groupId: group.id, pinned: group.prioritized }}
    >
      {({ ref, style, handle }) => (
        <WorkstreamGroup
          {...props}
          group={group}
          quietCount={focus.active && !group.prioritized}
          sectionRef={ref}
          style={style}
          handle={handle}
          dropTarget={dropGroupId === group.id}
        >
          {renderTrees(group)}
        </WorkstreamGroup>
      )}
    </Sortable>
  );

  const groupSort = prefs?.sidebar.groupSort ?? "alphabetical";
  // Unfiled, a group only while it has threads, sits between the populated
  // workstreams and the empty ones. With any workstream prioritized, the rest
  // (with Unfiled and Dormant) sit hidden behind a toggle below the
  // prioritized ones.
  const {
    pinned: pinnedGroups,
    populated: populatedGroups,
    empty: emptyGroups,
    tiered,
    hasLower,
  } = arrangeGroups(projection, groupSort);
  if (!tiered && (showLower || lowerExpanded.size > 0)) {
    setShowLower(false);
    setLowerExpanded(new Set());
  }
  const wasTiered = useRef(tiered);
  useLayoutEffect(() => {
    wasTiered.current = tiered;
  });
  // Entering or leaving tiers rearranges the whole list, which the priority
  // glide covers; only the toggle opens and closes the hidden block.
  const lowerPresence = usePresence(
    hasLower && (!tiered || showLower) ? ["lower"] : [],
    String,
    wasTiered.current === tiered,
  );
  const lowerCollapsed = (id: string, byDefault = false) =>
    tiered ? !lowerExpanded.has(id) : isCollapsed(id, byDefault);
  const lowerToggle = (id: string, byDefault = false) => {
    if (!tiered) return toggle(id, byDefault);
    setLowerExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };
  const toggleLower = () => {
    if (showLower) setLowerExpanded(new Set());
    setShowLower(!showLower);
  };
  const activeGroupProps = (
    group: ThreadGroup,
  ): Omit<GroupProps, "group" | "children"> => ({
    collapsed: group.prioritized
      ? isCollapsed(group.id)
      : lowerCollapsed(group.id),
    toggle: () =>
      group.prioritized ? toggle(group.id) : lowerToggle(group.id),
    onRename: () => renameWorkstream(group),
    onTogglePriority: () => togglePriority(group),
    onNewThread: () =>
      setNewWork({
        workstreamId: group.id,
        workstreamName: group.name,
      }),
  });
  /** An item that opens and closes with its presence phase. */
  const present = (entry: PresenceEntry<unknown>, children: ReactNode) => (
    <li
      key={entry.key}
      className="ws-presence list-none"
      {...presenceProps(entry.phase)}
    >
      <ul>{children}</ul>
    </li>
  );
  // Left edge matches the row titles: 26px with the status slot, 14px when
  // the rows fold it away (see styles.css).
  const bandControlClass = (tone: string) =>
    cn(
      "w-full cursor-pointer rounded-md py-0.5 pr-2 text-left text-[12px] transition-[padding] duration-[180ms] ease-out hover:bg-sidebar-accent/60 motion-reduce:transition-none",
      tone,
      needsMarks ? "pl-[26px]" : "pl-[14px]",
    );

  const recentBlock =
    ws.showRecent && recentRows.length > 0 ? (
      <Band
        key="recent"
        title="Recent"
        flipKey="recent"
        box="neutral"
        menu={
          <BandOptionsMenu
            section="recent"
            options={bandOptions.recent}
            onChange={(change) => updateBandOptions("recent", change)}
          />
        }
      >
        {renderBandRows(recentRows, "recent", "recent")}
      </Band>
    ) : null;
  /** Everything below the prioritized workstreams, as one opening block. */
  const lowerBlock = lowerPresence.map((entry) => (
    <div
      key="lower"
      data-flip-key="lower"
      className="ws-presence [--ws-presence-gap:0.5rem]"
      {...presenceProps(entry.phase)}
    >
      <div className="flex flex-col gap-2">
        <SortableContext
          items={populatedGroups.map((group) => groupKey(group.id))}
          strategy={verticalListSortingStrategy}
        >
          {populatedGroups.map((group) =>
            renderSortableGroup(group, activeGroupProps(group)),
          )}
        </SortableContext>
        {projection.unsorted.total > 0 ? (
          <DropTarget
            id={groupKey(projection.unsorted.id)}
            data={{ type: "target", groupId: projection.unsorted.id }}
          >
            {(ref) => (
              <WorkstreamGroup
                group={projection.unsorted}
                sectionRef={ref}
                collapsed={lowerCollapsed(projection.unsorted.id)}
                toggle={() => lowerToggle(projection.unsorted.id)}
                dropTarget={dropGroupId === projection.unsorted.id}
                quietCount={focus.active}
                muted
              >
                {renderTrees(projection.unsorted)}
              </WorkstreamGroup>
            )}
          </DropTarget>
        ) : null}
        <SortableContext
          items={emptyGroups.map((group) => groupKey(group.id))}
          strategy={verticalListSortingStrategy}
        >
          {emptyGroups.map((group) =>
            renderSortableGroup(group, activeGroupProps(group)),
          )}
        </SortableContext>
        {projection.dormant.length > 0 ? (
          <Band
            title="Dormant"
            flipKey="dormant"
            count={projection.dormant.length}
            collapsed={lowerCollapsed("__dormant", true)}
            toggle={() => lowerToggle("__dormant", true)}
          >
            <SortableContext
              items={projection.dormant.map((group) => groupKey(group.id))}
              strategy={verticalListSortingStrategy}
            >
              {projection.dormant.map((group) => (
                <li key={group.id} className="list-none">
                  {renderSortableGroup(group, {
                    collapsed: isCollapsed(group.id, true),
                    toggle: () => toggle(group.id, true),
                    onRename: () => renameWorkstream(group),
                    onTogglePriority: () => togglePriority(group),
                    muted: true,
                  })}
                </li>
              ))}
            </SortableContext>
          </Band>
        ) : null}
      </div>
    </div>
  ));
  if (ws.status === "loading")
    return <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>;
  if (ws.status === "error")
    return (
      <p className="px-3 py-2 text-xs text-destructive">
        Couldn't load threads.
      </p>
    );

  return (
    <DndContext {...contextProps}>
      <div ref={listRef} className="ws-list flex flex-col gap-2 pb-4 pt-1">
        <div className="mx-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setNewWork({ workstreamId: null })}
            className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[13px] text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
          >
            <span aria-hidden="true">＋</span> New work…
          </button>
          <SidebarViewOptionsMenu
            sort={groupSort}
            onChange={(groupSort) =>
              void savePrefs({ sidebar: { groupSort } }).catch(report)
            }
          />
        </div>
        <NewWorkDialog
          open={newWork !== null}
          workstreamId={newWork?.workstreamId ?? null}
          workstreamName={newWork?.workstreamName ?? null}
          onClose={() => setNewWork(null)}
        />
        {error ? (
          <p
            role="alert"
            className="mx-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
        {bandPresence.map((band) => (
          <div
            key={band.key}
            data-flip-key="up-next"
            className="ws-presence ws-up-next-sticky [--ws-presence-gap:0.5rem]"
            {...presenceProps(band.phase)}
          >
            <div>
              <Band
                title={UP_NEXT}
                box="attention"
                count={
                  shownNeedsRows.length > 1 ? shownNeedsRows.length : undefined
                }
                markless={!needsMarks}
                badge={
                  focus.active ? (
                    <span
                      title="Showing prioritized workstreams"
                      className="inline-flex"
                    >
                      <PriorityIcon className="size-3" />
                    </span>
                  ) : null
                }
              >
                {needsPresence.map((entry) =>
                  present(
                    entry,
                    renderOverlayTree(entry.item, "needs-you", needsMarks),
                  ),
                )}
                {needsControls.map((entry) =>
                  present(
                    entry,
                    <li>
                      <button
                        type="button"
                        onClick={() => setShowAllNeeds((all) => !all)}
                        className={bandControlClass("ws-amber-text")}
                      >
                        {showAllNeeds
                          ? "Show less"
                          : `Show ${Math.max(1, moreNeeds)} more`}
                      </button>
                    </li>,
                  ),
                )}
              </Band>
            </div>
          </div>
        ))}
        {tiered
          ? [
              <SortableContext
                key="pinned"
                items={pinnedGroups.map((group) => groupKey(group.id))}
                strategy={verticalListSortingStrategy}
              >
                {pinnedGroups.map((group) =>
                  renderSortableGroup(group, activeGroupProps(group)),
                )}
              </SortableContext>,
              ...(hasLower
                ? [
                    <button
                      key="lower-toggle"
                      type="button"
                      data-flip-key="lower-toggle"
                      aria-expanded={showLower}
                      onClick={toggleLower}
                      // A quiet link-style toggle, not a section header:
                      // the workstreams it reveals keep their own headers.
                      className="group/lower mx-2.5 flex items-center gap-1.5 self-start rounded-sm text-left text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
                    >
                      <span className="underline-offset-2 group-hover/lower:underline">
                        {showLower
                          ? "Hide lower priority workstreams"
                          : "Show lower priority workstreams"}
                      </span>
                      {!showLower && focus.elsewhere.length > 0 ? (
                        // What Up Next left out, so nothing waits unseen.
                        <span
                          title={`${focus.elsewhere.length} waiting on you`}
                          className="rounded-full bg-muted-foreground/15 px-1.5 text-[11px] font-medium tabular-nums"
                        >
                          <span aria-hidden="true">
                            {focus.elsewhere.length}
                          </span>
                          <span className="sr-only">
                            , {focus.elsewhere.length} waiting on you
                          </span>
                        </span>
                      ) : null}
                    </button>,
                  ]
                : []),
              ...lowerBlock,
              recentBlock,
            ]
          : [recentBlock, ...lowerBlock]}
        {ws.showArchived &&
        archived.experimental_archived?.status !== "error" &&
        (archivedThreads.length > 0 ||
          archived.experimental_archived?.status === "loading" ||
          archived.experimental_archived?.hasNextPage) ? (
          <Band
            title="Archived"
            flipKey="archived"
            count={archivedThreads.length}
            collapsed={isCollapsed("__archived", true)}
            toggle={() => toggle("__archived", true)}
            menu={
              <BandOptionsMenu
                section="archived"
                options={bandOptions.archived}
                onChange={(change) => updateBandOptions("archived", change)}
              />
            }
          >
            {bandOptions.archived.grouped
              ? [
                  ...archivedGroups,
                  ...(unsortedArchived.length > 0
                    ? [
                        {
                          id: "__unsorted",
                          name: UNFILED_NAME,
                          threads: unsortedArchived,
                        },
                      ]
                    : []),
                ].map((group) => {
                  const key = `archived:${group.id}`;
                  const collapsed = isCollapsed(key, true);
                  return (
                    <li key={key} className="list-none">
                      <section
                        aria-label={`Archived ${group.name}`}
                        className="px-1"
                      >
                        <button
                          type="button"
                          aria-expanded={!collapsed}
                          onClick={() => toggle(key, true)}
                          className="flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[12px] font-medium text-muted-foreground hover:bg-sidebar-accent/60"
                        >
                          <Icon
                            name={collapsed ? "ChevronRight" : "ChevronDown"}
                            className="size-3"
                          />
                          <WorkstreamName
                            name={group.name}
                            muted
                            className="flex-1 text-[12px]"
                          />
                          <span className="tabular-nums">
                            {group.threads.length}
                          </span>
                        </button>
                        {collapsed ? null : (
                          <ul className="mt-0.5">
                            {sortedBandRows(
                              group.threads.map((thread) => ({
                                thread,
                                depth: 0,
                                hasChildren: false,
                                workstreamId: archivedWorkstreamOf(thread),
                                needsYou: false,
                              })),
                              bandOptions.archived.sort,
                              ws.snoozeOf,
                            ).map((row) =>
                              renderRow(row, "archived", undefined, false),
                            )}
                          </ul>
                        )}
                      </section>
                    </li>
                  );
                })
              : renderBandRows(archivedRows, "archived", "archived")}
            {archived.experimental_archived?.status === "loading" ? (
              <li className="list-none px-2 py-1 text-xs text-muted-foreground">
                Loading archived threads…
              </li>
            ) : null}
            {archived.experimental_archived?.hasNextPage ? (
              <li className="list-none px-2 pt-1">
                <button
                  type="button"
                  disabled={archived.experimental_archived.isFetchingNextPage}
                  onClick={() =>
                    void archived.experimental_archived?.fetchNextPage()
                  }
                  className="w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground disabled:opacity-50"
                >
                  {archived.experimental_archived.isFetchingNextPage
                    ? "Loading…"
                    : "Load more archived threads"}
                </button>
              </li>
            ) : null}
          </Band>
        ) : null}
        {ws.showSnoozed && projection.snoozed.length > 0 ? (
          <Band
            title="Snoozed"
            flipKey="snoozed"
            count={projection.snoozed.filter((row) => row.depth === 0).length}
            collapsed={isCollapsed("__snoozed", true)}
            toggle={() => toggle("__snoozed", true)}
            menu={
              <BandOptionsMenu
                section="snoozed"
                options={bandOptions.snoozed}
                onChange={(change) => updateBandOptions("snoozed", change)}
              />
            }
          >
            {renderBandRows(projection.snoozed, "snoozed", "snoozed")}
          </Band>
        ) : null}
        <NameDialog
          request={nameRequest}
          onClose={() => setNameRequest(null)}
        />
        <CustomSnoozeDialog
          open={customSnooze !== null}
          onClose={() => setCustomSnooze(null)}
          onSubmit={(until) => {
            if (customSnooze) handlers.snooze(customSnooze, until);
          }}
        />
        {inspecting ? (
          <TraceInspector
            open
            onOpenChange={(open) => !open && setInspecting(null)}
            target={{ link: { kind: "thread", ref: inspecting.id } }}
            title={`Model calls for ${inspecting.displayTitle}`}
          />
        ) : null}
      </div>
    </DndContext>
  );
}

/** The section of threads waiting on the user. */
export const UP_NEXT = "Up Next";

/** Up Next shows this many rows until the user asks for the rest. */
const NEEDS_YOU_LIMIT = UP_NEXT_LIMIT;

/**
 * An overlay band. A plain band collapses from its header. A boxed band is an
 * always-open block spanning the column, with its header inside: `attention`
 * is the amber Up Next card (`.ws-needs`), `neutral` the
 * quieter Recent block (`.ws-band-neutral`). Both set their rows apart from
 * the workstream list below.
 */
function Band({
  title,
  count,
  box,
  badge,
  markless,
  collapsed,
  toggle,
  menu,
  flipKey,
  children,
}: {
  title: string;
  count?: number;
  box?: "attention" | "neutral";
  /** A small mark after the title. */
  badge?: ReactNode;
  /**
   * No row in a boxed band draws a status mark, so titles sit at the
   * collapsed slot's 14px indent; the header indents to match.
   */
  markless?: boolean;
  collapsed?: boolean;
  toggle?: () => void;
  menu?: ReactNode;
  /** Glides the band when a priority change moves it (see `useFlip`). */
  flipKey?: string;
  children: ReactNode;
}) {
  const heading = (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        {title}
        {badge}
      </span>
      {count !== undefined ? (
        <span
          className={cn(
            "tabular-nums",
            box === "attention" && "ws-needs-count",
          )}
        >
          {count}
        </span>
      ) : null}
    </>
  );
  if (box) {
    return (
      <section
        aria-label={title}
        data-flip-key={flipKey}
        className={cn(
          box === "attention"
            ? "ws-needs mx-2 my-1.5 p-1"
            : "ws-band-neutral my-1 px-2 py-1",
        )}
      >
        <div className="flex items-center gap-1">
          <h2
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1 pr-1.5",
              box === "attention"
                ? "py-1 text-[12px] font-medium"
                : "py-0.5 text-[11px] font-semibold uppercase tracking-wide",
              markless ? "pl-3.5" : "pl-1.5",
              box === "attention"
                ? "ws-needs-heading"
                : "text-muted-foreground",
            )}
          >
            {heading}
          </h2>
          {menu}
        </div>
        <ul className="mt-0.5">{children}</ul>
      </section>
    );
  }
  return (
    <section aria-label={title} data-flip-key={flipKey} className="px-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-sidebar-accent/60"
        >
          <Icon
            name={collapsed ? "ChevronRight" : "ChevronDown"}
            className="size-3"
          />
          {heading}
        </button>
        {menu}
      </div>
      {collapsed ? null : <ul className="mt-0.5">{children}</ul>}
    </section>
  );
}

function SidebarViewOptionsMenu({
  sort,
  onChange,
}: {
  sort: "alphabetical" | "activity" | "manual";
  onChange: (sort: "alphabetical" | "activity" | "manual") => void;
}) {
  const options = [
    ["alphabetical", "Name A–Z"],
    ["activity", "Recent activity"],
    ["manual", "Manual order"],
  ] as const;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Sidebar view options"
          title="Sidebar view options"
          onClick={(event) => event.stopPropagation()}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-50 hover:bg-sidebar-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100"
        >
          <Icon name="MoreHorizontal" className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          aria-label="Sidebar view options"
          className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <DropdownMenu.Label className="px-2 py-1.5 text-xs text-muted-foreground">
            Sort workstreams
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={sort}
            onValueChange={(value) =>
              onChange(value as "alphabetical" | "activity" | "manual")
            }
          >
            {options.map(([value, name]) => (
              <DropdownMenu.RadioItem
                key={value}
                value={value}
                className="flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
              >
                <span className="inline-flex size-4 items-center justify-center">
                  <DropdownMenu.ItemIndicator>
                    <Icon name="Check" className="size-3.5" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {name}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function BandOptionsMenu({
  section,
  options,
  onChange,
}: {
  section: BandId;
  options: BandOptions[BandId];
  onChange: (change: Partial<BandOptions[BandId]>) => void;
}) {
  const label = section[0]!.toUpperCase() + section.slice(1);
  const sortOptions: readonly BandSortOption[] =
    section === "recent"
      ? [
          ["activity", "Recent activity"],
          ["title", "Title A–Z"],
        ]
      : section === "snoozed"
        ? [
            ["wake", "Soonest to wake"],
            ["activity", "Recent activity"],
            ["title", "Title A–Z"],
          ]
        : [
            ["archived", "Archive date"],
            ["activity", "Recent activity"],
            ["title", "Title A–Z"],
          ];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Section options"
          title={`${label} options`}
          onClick={(event) => event.stopPropagation()}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-40 hover:bg-sidebar-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100"
        >
          <Icon name="MoreHorizontal" className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <DropdownMenu.Label className="px-2 py-1.5 text-xs text-muted-foreground">
            Sort by
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={options.sort}
            onValueChange={(value) => onChange({ sort: value as BandSort })}
          >
            {sortOptions.map(([value, name]) => (
              <DropdownMenu.RadioItem
                key={value}
                value={value}
                className="flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
              >
                <span className="inline-flex size-4 items-center justify-center">
                  <DropdownMenu.ItemIndicator>
                    <Icon name="Check" className="size-3.5" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {name}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.CheckboxItem
            checked={options.grouped}
            onCheckedChange={(checked) =>
              onChange({ grouped: checked === true })
            }
            className="flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
          >
            <span className="inline-flex size-4 items-center justify-center">
              <DropdownMenu.ItemIndicator>
                <Icon name="Check" className="size-3.5" />
              </DropdownMenu.ItemIndicator>
            </span>
            Group by workstream
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

type GroupProps = {
  group: ThreadGroup;
  collapsed: boolean;
  toggle: () => void;
  onRename?: () => void;
  onNewThread?: () => void;
  onTogglePriority?: () => void;
  muted?: boolean;
  /** Up Next is focused elsewhere, so the waiting count recedes. */
  quietCount?: boolean;
  /** Drag-and-drop wiring: the section moves, the header drags it. */
  sectionRef?: (element: HTMLElement | null) => void;
  style?: CSSProperties;
  handle?: DragHandle;
  /** A thread from another group is being dragged over this one. */
  dropTarget?: boolean;
  children: ReactNode;
};

function WorkstreamGroup({
  group,
  collapsed,
  toggle,
  onRename,
  onNewThread,
  onTogglePriority,
  muted,
  quietCount,
  sectionRef,
  style,
  handle,
  dropTarget,
  children,
}: GroupProps) {
  const { prefs } = usePrefs();
  const shows = (when: "always" | "collapsed" | "never" = "collapsed") =>
    when === "always" || (when === "collapsed" && collapsed);
  return (
    <section
      ref={sectionRef}
      style={style}
      aria-label={group.name}
      data-flip-key={`group:${group.id}`}
      data-prioritized={group.prioritized ? "" : undefined}
      data-drop-target={dropTarget ? "" : undefined}
      className={cn(
        "rounded-md px-1",
        dropTarget && "bg-sidebar-accent/40 ring-1 ring-sidebar-ring",
      )}
    >
      <GroupMenu
        onRename={onRename}
        onNewThread={onNewThread}
        priority={
          onTogglePriority
            ? { prioritized: group.prioritized, toggle: onTogglePriority }
            : undefined
        }
      >
        <div
          ref={handle?.ref}
          {...handle?.listeners}
          className="group/head flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-sidebar-accent/60"
        >
          <button
            type="button"
            aria-expanded={group.total > 0 ? !collapsed : undefined}
            onClick={group.total > 0 ? toggle : undefined}
            onDoubleClick={onRename}
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
          >
            {group.total > 0 ? (
              <Icon
                name={collapsed ? "ChevronRight" : "ChevronDown"}
                className="size-3 shrink-0 text-muted-foreground"
              />
            ) : null}
            <WorkstreamName
              name={group.name}
              muted={muted}
              className="text-[13px] font-semibold"
            />
          </button>
          {onTogglePriority ? (
            // Always shown on a prioritized workstream, where it is also the
            // priority mark; elsewhere it appears on hover like New work.
            <button
              type="button"
              aria-pressed={group.prioritized}
              aria-label={
                group.prioritized
                  ? `Remove priority from ${group.name}`
                  : `Prioritize ${group.name}`
              }
              title={group.prioritized ? "Remove priority" : "Prioritize"}
              onClick={onTogglePriority}
              className={cn(
                "rounded p-0.5 hover:text-foreground focus-visible:opacity-100",
                group.prioritized
                  ? "text-foreground/70"
                  : "text-muted-foreground opacity-0 group-hover/head:opacity-100",
              )}
            >
              <PriorityIcon filled={group.prioritized} className="size-3.5" />
            </button>
          ) : null}
          {onNewThread ? (
            <button
              type="button"
              aria-label={`New work in ${group.name}`}
              title={`New work in ${group.name}`}
              onClick={onNewThread}
              className={cn(
                "rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:opacity-100 group-hover/head:opacity-100",
                group.total > 0 && "opacity-0",
              )}
            >
              <Icon name="Plus" className="size-3.5" />
            </button>
          ) : null}
          {shows(prefs?.sidebar.waitingCount) && group.needsYou > 0 ? (
            <span
              className={cn(
                "rounded-full px-1.5 text-[11px] font-medium tabular-nums transition-colors duration-300",
                quietCount
                  ? "bg-muted-foreground/15 text-muted-foreground"
                  : "ws-amber-pill",
              )}
              title={`${group.needsYou} waiting on you`}
            >
              {group.needsYou}
            </span>
          ) : null}
          {shows(prefs?.sidebar.threadCount) && group.total > 0 ? (
            <span className="text-[11px] tabular-nums text-muted-foreground/70">
              {group.total}
            </span>
          ) : null}
        </div>
      </GroupMenu>
      {collapsed ? null : <ul className="mt-0.5">{children}</ul>}
    </section>
  );
}
