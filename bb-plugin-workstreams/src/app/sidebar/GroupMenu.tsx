import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { usePortalScopeProps } from "@/lib/portal-scope";

const itemClass =
  "flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

/** Right-click menu on a workstream header. */
export function GroupMenu({
  onRename,
  onNewThread,
  priority,
  children,
}: {
  onRename?: () => void;
  onNewThread?: () => void;
  /** Prioritize the workstream, or remove its priority. */
  priority?: { prioritized: boolean; toggle: () => void };
  children: ReactNode;
}) {
  const portalScope = usePortalScopeProps();
  if (!onRename && !onNewThread && !priority) return <>{children}</>;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...portalScope}
          aria-label="Workstream actions"
          className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {onNewThread ? (
            <ContextMenu.Item className={itemClass} onSelect={onNewThread}>
              New thread here
            </ContextMenu.Item>
          ) : null}
          {priority ? (
            <ContextMenu.Item className={itemClass} onSelect={priority.toggle}>
              {priority.prioritized ? "Remove priority" : "Prioritize"}
            </ContextMenu.Item>
          ) : null}
          {onRename ? (
            <ContextMenu.Item className={itemClass} onSelect={onRename}>
              Rename workstream…
            </ContextMenu.Item>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
