import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  experimental_useSidebarThreadActions,
  type PluginSidebarSection,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";

export type RowMenuHandlers = {
  move: (thread: PluginSidebarThread, sectionId: string | null) => void;
  newWorkstream: (thread: PluginSidebarThread) => void;
  rename: (thread: PluginSidebarThread) => void;
  openParent: (thread: PluginSidebarThread) => void;
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
  children,
}: {
  thread: PluginSidebarThread;
  isRoot: boolean;
  workstreamId: string | null;
  sections: readonly PluginSidebarSection[];
  handlers: RowMenuHandlers;
  children: ReactNode;
}) {
  const actions = experimental_useSidebarThreadActions();
  const portalScope = usePortalScopeProps();
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
              <ContextMenu.SubTrigger className={itemClass}>
                Move to workstream
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent
                  {...portalScope}
                  className="z-50 max-h-96 min-w-48 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
                >
                  {sections.map((section) => (
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
                    Unsorted
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
          <Separator />
          <Item onSelect={() => actions.archive(thread.id)}>Archive</Item>
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

function Separator() {
  return <ContextMenu.Separator className="my-1 h-px bg-border" />;
}
