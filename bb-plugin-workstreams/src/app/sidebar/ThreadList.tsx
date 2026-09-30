/**
 * The Workstreams sidebar thread list: the For you section and the Recent
 * band as overlays, then one group per workstream (BB section, in the user's
 * drag-and-drop order, else BB's), Unsorted, a Dormant fold, and a Snoozed
 * fold. Every visible thread appears in exactly one group, or in Snoozed
 * (SPEC I1).
 */
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  experimental_useSidebarThreadActions,
  useBbNavigate,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Group, Row as RowModel } from "../../domain/project.ts";
import { useWorkstreams } from "../useWorkstreams.ts";
import { useCollapsed } from "./useCollapsed.ts";
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
import { SnoozeMenuItems } from "../snooze/SnoozeMenuItems.tsx";

type ThreadGroup = Group<PluginSidebarThread>;
type ThreadRow = RowModel<PluginSidebarThread>;
/** Where a row is drawn: its workstream group, or one of the overlays. */
type Placement = "group" | "needs-you" | "recent" | "snoozed";

const groupKey = (id: string) => `ws:${id}`;
const treeKey = (id: string) => `t:${id}`;

/** A group's rows split into trees, each led by its root. */
function treesOf(rows: readonly ThreadRow[]): ThreadRow[][] {
  const trees: ThreadRow[][] = [];
  for (const row of rows)
    if (row.depth === 0 || trees.length === 0) trees.push([row]);
    else trees.at(-1)!.push(row);
  return trees;
}

export function WorkstreamsThreadList({
  activeThreadId,
  onNavigate,
}: PluginThreadListProps) {
  const ws = useWorkstreams();
  const actions = experimental_useSidebarThreadActions();
  const navigate = useBbNavigate();
  const { isCollapsed, toggle } = useCollapsed();
  const [nameRequest, setNameRequest] = useState<NameRequest | null>(null);
  const [newWork, setNewWork] = useState<{
    workstreamId: string | null;
    workstreamName?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAllNeeds, setShowAllNeeds] = useState(false);
  const [inspecting, setInspecting] = useState<PluginSidebarThread | null>(
    null,
  );
  const [customSnooze, setCustomSnooze] = useState<PluginSidebarThread | null>(
    null,
  );
  const { projection, sections, now } = ws;
  const nameOf = new Map(sections.map((s) => [s.id, s.name]));

  const listRef = useRef<HTMLDivElement>(null);

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
  const defaultSnoozeTitle = `Snooze ${describeWake(wakeTime(ws.defaultSnooze, now), now)}`;
  const renameWorkstream = (group: ThreadGroup) =>
    setNameRequest({
      title: "Rename workstream",
      initial: group.name,
      submitLabel: "Rename",
      onSubmit: async (name) => {
        await ws.rpc.call("renameWorkstream", { sectionId: group.id, name });
      },
    });

  const workstreamName = (row: ThreadRow) =>
    row.workstreamId ? nameOf.get(row.workstreamId) : "Unsorted";
  /** What a For you thread asks of Tom, from its current analysis. */
  const askOf = (row: ThreadRow) => {
    const work = ws.work(row.thread);
    return work?.kind === "current" ? work.analysis.needsYou : null;
  };
  /** Whether any of these rows draws a status mark (see `hasStatusMark`). */
  const anyMark = (rows: readonly ThreadRow[], placement: Placement) =>
    rows.some((row) =>
      hasStatusMark(row.thread, ws.work(row.thread), placement === "needs-you"),
    );
  const needsRows = showAllNeeds
    ? projection.needsYou
    : projection.needsYou.slice(0, NEEDS_YOU_LIMIT);
  const needsMarks = anyMark(needsRows, "needs-you");
  /**
   * The row's hover snooze button and the menu beside it. In Snoozed, a
   * thread with its own snooze wakes; a descendant that is only there with
   * its parent has none.
   */
  const snoozeActionOf = (row: ThreadRow, placement: Placement) => {
    const snooze = ws.snoozeOf(row.thread);
    if (placement === "snoozed" && !snooze) return undefined;
    const menu = (
      <SnoozeMenuItems
        now={now}
        preset={ws.defaultSnooze}
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
          handlers.snooze(row.thread, wakeTime(ws.defaultSnooze, Date.now())),
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
  ) => (
    <RowMenu
      key={row.thread.id}
      thread={row.thread}
      isRoot={isRoot(row, placement)}
      workstreamId={row.workstreamId}
      sections={sections}
      handlers={handlers}
      snooze={ws.snoozeOf(row.thread)}
    >
      <li ref={handle?.ref} {...handle?.listeners} className="list-none">
        <Row
          thread={row.thread}
          depth={
            placement === "group" || placement === "snoozed" ? row.depth : 0
          }
          active={row.thread.id === activeThreadId}
          now={now}
          context={contextOf(row, placement)}
          attention={placement === "needs-you"}
          work={ws.work(row.thread)}
          proposal={ws.proposalOf.get(row.thread.id)?.text}
          showStatusSlot={showStatusSlot}
          subtitle={placement === "needs-you" ? askOf(row) : null}
          snoozeAction={snoozeActionOf(row, placement)}
          onNavigate={onNavigate}
        />
      </li>
    </RowMenu>
  );
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
                    {tree.map((row, index) =>
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
      data={{ type: "group", groupId: group.id }}
    >
      {({ ref, style, handle }) => (
        <WorkstreamGroup
          {...props}
          group={group}
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
        <button
          type="button"
          onClick={() => setNewWork({ workstreamId: null })}
          className="mx-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-left text-[13px] text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
        >
          <span aria-hidden="true">＋</span> New work
        </button>
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
        {ws.showForYou && projection.needsYou.length > 0 ? (
          <Band title="For you" box="attention">
            {needsRows.map((row) =>
              renderRow(row, "needs-you", undefined, needsMarks),
            )}
            {projection.needsYou.length > NEEDS_YOU_LIMIT ? (
              <li>
                <button
                  type="button"
                  onClick={() => setShowAllNeeds((all) => !all)}
                  // Left edge matches the row titles: 26px with the status
                  // slot, 14px when the rows fold it away (see styles.css).
                  className={cn(
                    "ws-amber-text w-full cursor-pointer rounded-md py-0.5 pr-2 text-left text-[12px] transition-[padding] duration-[180ms] ease-out hover:bg-sidebar-accent/60 motion-reduce:transition-none",
                    needsMarks ? "pl-[26px]" : "pl-[14px]",
                  )}
                >
                  {showAllNeeds
                    ? "Show less"
                    : `Show ${projection.needsYou.length - NEEDS_YOU_LIMIT} more`}
                </button>
              </li>
            ) : null}
          </Band>
        ) : null}
        {ws.showRecent && projection.recent.length > 0 ? (
          <Band title="Recent" box="neutral">
            {projection.recent.map((row) =>
              renderRow(
                row,
                "recent",
                undefined,
                anyMark(projection.recent, "recent"),
              ),
            )}
          </Band>
        ) : null}
        <SortableContext
          items={projection.groups.map((group) => groupKey(group.id))}
          strategy={verticalListSortingStrategy}
        >
          {projection.groups.map((group) =>
            renderSortableGroup(group, {
              collapsed: isCollapsed(group.id),
              toggle: () => toggle(group.id),
              onRename: () => renameWorkstream(group),
              onNewThread: () =>
                setNewWork({
                  workstreamId: group.id,
                  workstreamName: group.name,
                }),
            }),
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
                collapsed={isCollapsed(projection.unsorted.id)}
                toggle={() => toggle(projection.unsorted.id)}
                dropTarget={dropGroupId === projection.unsorted.id}
                muted
              >
                {renderTrees(projection.unsorted)}
              </WorkstreamGroup>
            )}
          </DropTarget>
        ) : null}
        {projection.dormant.length > 0 ? (
          <Band
            title="Dormant"
            count={projection.dormant.length}
            collapsed={isCollapsed("__dormant", true)}
            toggle={() => toggle("__dormant", true)}
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
                    muted: true,
                  })}
                </li>
              ))}
            </SortableContext>
          </Band>
        ) : null}
        {projection.snoozed.length > 0 ? (
          <Band
            title="Snoozed"
            count={projection.snoozed.filter((row) => row.depth === 0).length}
            collapsed={isCollapsed("__snoozed", true)}
            toggle={() => toggle("__snoozed", true)}
          >
            {projection.snoozed.map((row) =>
              renderRow(
                row,
                "snoozed",
                undefined,
                anyMark(projection.snoozed, "snoozed"),
              ),
            )}
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

/** For you shows this many rows until the user asks for the rest. */
const NEEDS_YOU_LIMIT = 5;

/**
 * An overlay band. A plain band collapses from its header. A boxed band is an
 * always-open block spanning the column, with its header inside: `attention`
 * is the amber For you block (`.ws-needs`, with its shimmer), `neutral` the
 * quieter Recent block (`.ws-band-neutral`). Both set their rows apart from
 * the workstream list below.
 */
function Band({
  title,
  count,
  box,
  collapsed,
  toggle,
  children,
}: {
  title: string;
  count?: number;
  box?: "attention" | "neutral";
  collapsed?: boolean;
  toggle?: () => void;
  children: ReactNode;
}) {
  const heading = (
    <>
      <span className="flex-1 text-left">{title}</span>
      {count !== undefined ? (
        <span className="tabular-nums">{count}</span>
      ) : null}
    </>
  );
  if (box) {
    return (
      <section
        aria-label={title}
        className={cn(
          "my-1 px-2 py-1",
          box === "attention" ? "ws-needs" : "ws-band-neutral",
        )}
      >
        <h2
          className={cn(
            "flex w-full items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
            box === "attention" ? "ws-amber-text" : "text-muted-foreground",
          )}
        >
          {heading}
        </h2>
        <ul className="mt-0.5">{children}</ul>
      </section>
    );
  }
  return (
    <section aria-label={title} className="px-1">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={toggle}
        className="flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-sidebar-accent/60"
      >
        <Icon
          name={collapsed ? "ChevronRight" : "ChevronDown"}
          className="size-3"
        />
        {heading}
      </button>
      {collapsed ? null : <ul className="mt-0.5">{children}</ul>}
    </section>
  );
}

type GroupProps = {
  group: ThreadGroup;
  collapsed: boolean;
  toggle: () => void;
  onRename?: () => void;
  onNewThread?: () => void;
  muted?: boolean;
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
  muted,
  sectionRef,
  style,
  handle,
  dropTarget,
  children,
}: GroupProps) {
  return (
    <section
      ref={sectionRef}
      style={style}
      aria-label={group.name}
      data-drop-target={dropTarget ? "" : undefined}
      className={cn(
        "rounded-md px-1",
        dropTarget && "bg-sidebar-accent/40 ring-1 ring-sidebar-ring",
      )}
    >
      <GroupMenu onRename={onRename} onNewThread={onNewThread}>
        <div
          ref={handle?.ref}
          {...handle?.listeners}
          className="group/head flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-sidebar-accent/60"
        >
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={toggle}
            onDoubleClick={onRename}
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
          >
            <Icon
              name={collapsed ? "ChevronRight" : "ChevronDown"}
              className="size-3 shrink-0 text-muted-foreground"
            />
            <span
              className={cn(
                "truncate text-[13px] font-semibold",
                muted ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {group.name}
            </span>
          </button>
          {onNewThread ? (
            <button
              type="button"
              aria-label={`New thread in ${group.name}`}
              title={`New thread in ${group.name}`}
              onClick={onNewThread}
              className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/head:opacity-100"
            >
              <Icon name="Plus" className="size-3.5" />
            </button>
          ) : null}
          {group.needsYou > 0 ? (
            <span
              className="ws-amber-pill rounded-full px-1.5 text-[11px] font-medium tabular-nums"
              title={`${group.needsYou} for you`}
            >
              {group.needsYou}
            </span>
          ) : null}
          <span className="text-[11px] tabular-nums text-muted-foreground/70">
            {group.total}
          </span>
        </div>
      </GroupMenu>
      {collapsed ? null : <ul className="mt-0.5">{children}</ul>}
    </section>
  );
}
