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
import { topicPath } from "../../domain/topic-path.ts";
import { useSharedServerState } from "../serverState.ts";
import { isAutomaticTopic } from "../task/TaskIdentity.tsx";

export type RowMenuHandlers = {
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

  // Topic submenu: the same choices as the thread header's Topic control.
  const entities = server.catalog?.entities ?? [];
  const assignment = server.catalog?.assignments[thread.id] ?? null;
  const currentEntity = assignment?.entityId
    ? (entities.find((e) => e.id === assignment.entityId) ?? null)
    : null;
  const displayTopicPath = (id: string) =>
    topicPath(id, entities).replace(/: /g, " › ");
  const currentLabel = currentEntity ? displayTopicPath(currentEntity.id) : "No topic";
  const isFork = Boolean(assignment?.inheritedFrom);
  const automatic = isAutomaticTopic(assignment);
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
          <ContextMenu.Sub>
            <SubTrigger>Topic</SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent
                {...portalScope}
                className="z-50 max-h-96 min-w-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
              >
                {isFork ? (
                  <Item disabled onSelect={() => undefined}>
                    <span className="flex-1 truncate">
                      {currentLabel} (same as parent thread)
                    </span>
                  </Item>
                ) : (
                  <>
                    <Item
                      disabled={automatic}
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
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span>Automatic</span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {automatic ? currentLabel : "Let Workstreams choose"}
                        </span>
                      </span>
                      {automatic ? (
                        <Icon name="Check" className="ml-2 size-3.5" />
                      ) : null}
                    </Item>
                    <Separator />
                    {entities.length ? (
                      entities
                        .slice()
                        .sort((a, b) =>
                          compareGroupNames(displayTopicPath(a.id), displayTopicPath(b.id)),
                        )
                        .map((entity) => {
                          const isChosen =
                            !automatic && entity.id === currentEntity?.id;
                          return (
                            <Item
                              key={entity.id}
                              disabled={isChosen}
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
                              <span className="flex-1 truncate">
                                {displayTopicPath(entity.id)}
                              </span>
                              {isChosen ? (
                                <Icon name="Check" className="ml-2 size-3.5" />
                              ) : null}
                            </Item>
                          );
                        })
                    ) : (
                      <Item disabled onSelect={() => undefined}>
                        No topics yet
                      </Item>
                    )}
                  </>
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
