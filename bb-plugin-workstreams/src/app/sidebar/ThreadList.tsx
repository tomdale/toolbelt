/**
 * The Workstreams sidebar thread list: Needs you and Recent overlays, then one
 * group per workstream (BB section, in BB's order), Unsorted, and a Dormant
 * fold. Every visible thread appears in exactly one group (SPEC I1).
 */
import { useState, type ReactNode } from "react";
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
import { Row } from "./Row.tsx";
import { RowMenu, type RowMenuHandlers } from "./RowMenu.tsx";
import { GroupMenu } from "./GroupMenu.tsx";
import { NewWorkDialog } from "../composer/NewWork.tsx";

type ThreadGroup = Group<PluginSidebarThread>;

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
  const { projection, sections, now } = ws;
  const nameOf = new Map(sections.map((s) => [s.id, s.name]));

  const report = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  const handlers: RowMenuHandlers = {
    move: (thread, sectionId) => {
      setError(null);
      ws.rpc
        .call("moveThread", { threadId: thread.id, sectionId })
        .catch(report);
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
  };
  const renameWorkstream = (group: ThreadGroup) =>
    setNameRequest({
      title: "Rename workstream",
      initial: group.name,
      submitLabel: "Rename",
      onSubmit: async (name) => {
        await ws.rpc.call("renameWorkstream", { sectionId: group.id, name });
      },
    });

  const bandContext = (row: RowModel<PluginSidebarThread>) => {
    const via = projection.needsYouVia.get(row.thread.id);
    if (via?.length) return `via ${via[0]!.displayTitle}`;
    return row.workstreamId ? nameOf.get(row.workstreamId) : "Unsorted";
  };
  const renderRow = (row: RowModel<PluginSidebarThread>, band?: boolean) => (
    <RowMenu
      key={row.thread.id}
      thread={row.thread}
      isRoot={row.depth === 0}
      workstreamId={row.workstreamId}
      sections={sections}
      handlers={handlers}
    >
      <li className="list-none">
        <Row
          thread={row.thread}
          depth={band ? 0 : row.depth}
          active={row.thread.id === activeThreadId}
          now={now}
          context={band ? bandContext(row) : undefined}
          work={ws.work(row.thread)}
          proposal={ws.proposalOf.get(row.thread.id)?.text}
          onNavigate={onNavigate}
        />
      </li>
    </RowMenu>
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
    <div className="ws-list flex flex-col gap-2 pb-4 pt-1">
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
      {projection.needsYou.length > 0 ? (
        <Band
          title="Needs you"
          count={projection.needsYou.length}
          tone="attention"
          collapsed={isCollapsed("__needs")}
          toggle={() => toggle("__needs")}
        >
          {projection.needsYou.map((row) => renderRow(row, true))}
        </Band>
      ) : null}
      {ws.showRecent && projection.recent.length > 0 ? (
        <Band
          title="Recent"
          collapsed={isCollapsed("__recent")}
          toggle={() => toggle("__recent")}
        >
          {projection.recent.map((row) => renderRow(row, true))}
        </Band>
      ) : null}
      {projection.groups.map((group) => (
        <WorkstreamGroup
          key={group.id}
          group={group}
          collapsed={isCollapsed(group.id)}
          toggle={() => toggle(group.id)}
          onRename={() => renameWorkstream(group)}
          onNewThread={() =>
            setNewWork({ workstreamId: group.id, workstreamName: group.name })
          }
        >
          {group.rows.map((row) => renderRow(row))}
        </WorkstreamGroup>
      ))}
      {projection.unsorted.total > 0 ? (
        <WorkstreamGroup
          group={projection.unsorted}
          collapsed={isCollapsed(projection.unsorted.id)}
          toggle={() => toggle(projection.unsorted.id)}
          muted
        >
          {projection.unsorted.rows.map((row) => renderRow(row))}
        </WorkstreamGroup>
      ) : null}
      {projection.dormant.length > 0 ? (
        <Band
          title="Dormant"
          count={projection.dormant.length}
          collapsed={isCollapsed("__dormant", true)}
          toggle={() => toggle("__dormant", true)}
        >
          {projection.dormant.map((group) => (
            <li key={group.id} className="list-none">
              <WorkstreamGroup
                group={group}
                collapsed={isCollapsed(group.id, true)}
                toggle={() => toggle(group.id, true)}
                onRename={() => renameWorkstream(group)}
                muted
              >
                {group.rows.map((row) => renderRow(row))}
              </WorkstreamGroup>
            </li>
          ))}
        </Band>
      ) : null}
      <NameDialog request={nameRequest} onClose={() => setNameRequest(null)} />
    </div>
  );
}

function Band({
  title,
  count,
  tone,
  collapsed,
  toggle,
  children,
}: {
  title: string;
  count?: number;
  tone?: "attention";
  collapsed: boolean;
  toggle: () => void;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="px-1">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={toggle}
        className={cn(
          "flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
          tone === "attention" ? "text-amber-500" : "text-muted-foreground",
          "hover:bg-sidebar-accent/60",
        )}
      >
        <Icon
          name={collapsed ? "ChevronRight" : "ChevronDown"}
          className="size-3"
        />
        <span className="flex-1 text-left">{title}</span>
        {count !== undefined ? (
          <span className="tabular-nums">{count}</span>
        ) : null}
      </button>
      {collapsed ? null : <ul className="mt-0.5">{children}</ul>}
    </section>
  );
}

function WorkstreamGroup({
  group,
  collapsed,
  toggle,
  onRename,
  onNewThread,
  muted,
  children,
}: {
  group: ThreadGroup;
  collapsed: boolean;
  toggle: () => void;
  onRename?: () => void;
  onNewThread?: () => void;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={group.name} className="px-1">
      <GroupMenu onRename={onRename} onNewThread={onNewThread}>
        <div className="group/head flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-sidebar-accent/60">
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
              className="rounded-full bg-amber-500/20 px-1.5 text-[11px] font-medium tabular-nums text-amber-500"
              title={`${group.needsYou} need${group.needsYou === 1 ? "s" : ""} you`}
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
