import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  experimental_useSidebarThreadActions,
  type PluginSidebarSection,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import { useDebugMode } from "../debug/debug.ts";
import { snoozeChoices, type ThreadSnooze } from "../../domain/snooze.ts";
import { compareGroupNames } from "../../domain/group-name-order.ts";
import { corpusLabel } from "../../domain/corpus-label.ts";
import { useSharedServerState } from "../serverState.ts";

export type RowMenuHandlers = {
  move: (thread: PluginSidebarThread, sectionId: string | null) => void;
  newWorkstream: (thread: PluginSidebarThread) => void;
  rename: (thread: PluginSidebarThread) => void;
  openParent: (thread: PluginSidebarThread) => void;
  /** Snoozes until a time, or (null) until the thread's next activity. */
  snooze: (thread: PluginSidebarThread, until: number | null) => void;
  /** Opens the date-and-time picker. */
  customSnooze: (thread: PluginSidebarThread) => void;
  wake: (thread: PluginSidebarThread) => void;
  /** Debug mode: opens the thread's model calls. */
  inspect: (thread: PluginSidebarThread) => void;
  assignIdentity?: (thread: PluginSidebarThread, entityId: string) => void;
  clearIdentity?: (thread: PluginSidebarThread) => void;
  reclassifyIdentity?: (thread: PluginSidebarThread) => void;
};

/**
 * The row's right-click menu. The SDK ships no menu component; every item is
 * a sidebar thread action or a Workstreams RPC, and Delete goes through BB's
 * own confirmation.
 */
export function RowMenu({
  thread,
  isRoot,
  workstreamId,
  sections,
  handlers,
  snooze,
  morningHour,
  showArchive = true,
  children,
}: {
  thread: PluginSidebarThread;
  isRoot: boolean;
  workstreamId: string | null;
  sections: readonly PluginSidebarSection[];
  handlers: RowMenuHandlers;
  /** The thread's snooze, while it holds. */
  snooze?: ThreadSnooze;
  /** When "morning" choices wake (the Snooze settings). */
  morningHour: number;
  showArchive?: boolean;
  children: ReactNode;
}) {
  const actions = experimental_useSidebarThreadActions();
  const portalScope = usePortalScopeProps();
  const debug = useDebugMode();
  const { server, rpc, refresh } = useSharedServerState();

  const catalog = server.catalog;
  const entities = catalog?.entities ?? [];
  const assignment = catalog?.assignments[thread.id];
  const currentEntity = assignment?.entityId
    ? (entities.find((e) => e.id === assignment.entityId) ?? null)
    : null;
  const currentLabel = currentEntity
    ? corpusLabel(currentEntity.id, entities).replace(/: /g, " › ")
    : "Unresolved";
  const isInherited = Boolean(assignment?.inheritedFrom);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...portalScope}
          aria-label="Thread actions"
          className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <Item onSelect={() => actions.open(thread.id, { split: true })}>
            Open in split
          </Item>
          {thread.parentThreadId ? (
            <Item onSelect={() => handlers.openParent(thread)}>
              Open parent
            </Item>
          ) : null}
          <Separator />
          {isRoot ? (
            <ContextMenu.Sub>
              <SubTrigger>Move to workstream</SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent
                  {...portalScope}
                  className="z-50 max-h-96 min-w-48 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
                >
                  {[...sections]
                    .sort((a, b) => compareGroupNames(a.name, b.name))
                    .map((section) => (
                      <Item
                        key={section.id}
                        disabled={section.id === workstreamId}
                        onSelect={() => handlers.move(thread, section.id)}
                      >
                        {section.name}
                      </Item>
                    ))}
                  <Item
                    disabled={workstreamId === null}
                    onSelect={() => handlers.move(thread, null)}
                  >
                    Unfiled
                  </Item>
                  <Separator />
                  <Item onSelect={() => handlers.newWorkstream(thread)}>
                    New workstream…
                  </Item>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          ) : (
            <Item disabled onSelect={() => undefined}>
              Moves with its parent
            </Item>
          )}
          <ContextMenu.Sub>
            <SubTrigger>Product or feature</SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent
                {...portalScope}
                className="z-50 max-h-96 min-w-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
              >
                <div className="px-2 py-1.5 text-xs text-muted-foreground font-medium">
                  Current: {currentLabel}
                  {isInherited ? " (inherited)" : ""}
                </div>
                <Separator />
                <Item
                  onSelect={() => {
                    if (handlers.reclassifyIdentity) {
                      handlers.reclassifyIdentity(thread);
                    } else {
                      void rpc
                        .call("taskReclassify", { threadId: thread.id })
                        .then(() => refresh());
                    }
                  }}
                >
                  Reclassify
                </Item>
                {currentEntity ? (
                  <Item
                    onSelect={() => {
                      if (handlers.clearIdentity) {
                        handlers.clearIdentity(thread);
                      } else {
                        void rpc
                          .call("taskClear", { threadId: thread.id })
                          .then(() => refresh());
                      }
                    }}
                  >
                    Clear assignment
                  </Item>
                ) : null}
                <Separator />
                <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Assign to
                </div>
                {entities.length ? (
                  entities
                    .slice()
                    .sort((a, b) => compareGroupNames(a.name, b.name))
                    .map((entity) => {
                      const label = corpusLabel(entity.id, entities).replace(
                        /: /g,
                        " › ",
                      );
                      const isSelected = entity.id === currentEntity?.id;
                      return (
                        <Item
                          key={entity.id}
                          disabled={isSelected}
                          onSelect={() => {
                            if (handlers.assignIdentity) {
                              handlers.assignIdentity(thread, entity.id);
                            } else {
                              void rpc
                                .call("taskAssign", {
                                  threadId: thread.id,
                                  entityId: entity.id,
                                })
                                .then(() => refresh());
                            }
                          }}
                        >
                          <span className="flex-1 truncate">{label}</span>
                          {isSelected ? (
                            <Icon name="Check" className="ml-2 size-3.5" />
                          ) : null}
                        </Item>
                      );
                    })
                ) : (
                  <Item disabled onSelect={() => undefined}>
                    No catalog entities
                  </Item>
                )}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <Item onSelect={() => handlers.rename(thread)}>Rename…</Item>
          <Item
            onSelect={() => void actions.setPinned(thread.id, !thread.isPinned)}
          >
            {thread.isPinned ? "Unpin" : "Pin"}
          </Item>
          <Item
            onSelect={() => void actions.setRead(thread.id, thread.isUnread)}
          >
            {thread.isUnread ? "Mark read" : "Mark unread"}
          </Item>
          {debug ? (
            <>
              <Separator />
              <Item onSelect={() => handlers.inspect(thread)}>
                Inspect model calls…
              </Item>
            </>
          ) : null}
          <Separator />
          {snooze ? (
            <Item onSelect={() => handlers.wake(thread)}>Wake now</Item>
          ) : null}
          <ContextMenu.Sub>
            <SubTrigger>{snooze ? "Change snooze" : "Snooze"}</SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent
                {...portalScope}
                className="z-50 min-w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
              >
                {snoozeChoices(Date.now(), { morningHour }).map((choice) => (
                  <Item
                    key={choice.id}
                    onSelect={() => handlers.snooze(thread, choice.until)}
                  >
                    <span className="flex-1">{choice.label}</span>
                    {choice.hint ? (
                      <span className="ml-4 text-xs text-muted-foreground">
                        {choice.hint}
                      </span>
                    ) : null}
                  </Item>
                ))}
                <Separator />
                <Item onSelect={() => handlers.customSnooze(thread)}>
                  Pick a date and time…
                </Item>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          {showArchive ? (
            <Item onSelect={() => actions.archive(thread.id)}>Archive</Item>
          ) : null}
          <Item destructive onSelect={() => actions.requestDelete(thread.id)}>
            Delete…
          </Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

const itemClass = cn(
  "flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none",
  "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
  "data-[disabled]:cursor-default data-[disabled]:opacity-50",
);

function Item({
  children,
  destructive = false,
  disabled = false,
  onSelect,
}: {
  children: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(itemClass, destructive && "text-destructive")}
    >
      {children}
    </ContextMenu.Item>
  );
}

/** An item that opens a submenu, marked with a trailing chevron. */
function SubTrigger({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.SubTrigger
      className={cn(
        itemClass,
        "gap-2 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
      )}
    >
      <span className="flex-1">{children}</span>
      <Icon
        name="ChevronRight"
        className="size-3.5 text-muted-foreground"
        aria-hidden="true"
      />
    </ContextMenu.SubTrigger>
  );
}

function Separator() {
  return <ContextMenu.Separator className="my-1 h-px bg-border" />;
}
