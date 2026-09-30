/**
 * Snooze in the thread header: a split button whose face snoozes with the
 * default choice (the `snoozeDefault` setting) and whose arrow lists every
 * choice. A snoozed thread shows when it wakes instead, with Wake now in its
 * menu. BB's own thread menu takes no plugin items, so this is the header's
 * snooze entry point, alongside the command palette.
 */
import { useEffect, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  experimental_useSidebarThreads,
  useSettings,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import {
  describeWake,
  isSnoozed,
  presetFromSetting,
  presetLabel,
  shortWake,
  snoozeChoices,
  wakeTime,
} from "../../domain/snooze.ts";
import { useNow, useServerState } from "../useWorkstreams.ts";
import { snoozeThread, wakeThread } from "./actions.ts";
import { CustomSnoozeDialog } from "./CustomSnoozeDialog.tsx";
import { SnoozeIcon } from "./icons.tsx";

/**
 * Header snooze controls by thread, so the command palette acts on the same
 * state as the button.
 */
export const headerSnoozers = new Map<
  string,
  { snoozed: boolean; snooze: () => void; wake: () => void }
>();

export function SnoozeHeaderAction({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { server, setSnooze } = useServerState();
  const { threads } = experimental_useSidebarThreads({
    experimental_lifecycles: ["active"],
  });
  const settings = useSettings();
  const portalScope = usePortalScopeProps();
  const [picking, setPicking] = useState(false);
  const thread = threads.find((t) => t.id === threadId);
  const preset = presetFromSetting(
    (settings.values as Record<string, unknown> | undefined)?.snoozeDefault,
  );
  const now = useNow();
  const stored = server.snoozes[threadId];
  const snooze = thread && isSnoozed(stored, thread, now) ? stored : undefined;

  const snoozeUntil = (until: number | null) => {
    if (thread) snoozeThread(setSnooze, thread, until, snooze);
  };
  const snoozeDefault = () => snoozeUntil(wakeTime(preset, Date.now()));
  const wake = () => {
    if (thread) wakeThread(setSnooze, thread);
  };

  useEffect(() => {
    if (!thread) return;
    const entry = { snoozed: Boolean(snooze), snooze: snoozeDefault, wake };
    headerSnoozers.set(threadId, entry);
    return () => {
      if (headerSnoozers.get(threadId) === entry)
        headerSnoozers.delete(threadId);
    };
  });

  // Hidden and archived threads aren't in the sidebar, so there's nothing
  // to snooze them out of.
  if (!thread) return null;

  const defaultTitle = `Snooze: ${presetLabel(preset).toLowerCase()}`;
  const menu = (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        {...portalScope}
        align="end"
        sideOffset={4}
        className="z-50 min-w-60 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
      >
        {snooze ? (
          <>
            <DropdownMenu.Label className="px-2 py-1.5 text-xs text-muted-foreground">
              Snoozed {describeWake(snooze.until, now)}
            </DropdownMenu.Label>
            <MenuItem onSelect={wake}>Wake now</MenuItem>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
          </>
        ) : null}
        {snoozeChoices(now).map((choice) => (
          <MenuItem key={choice.id} onSelect={() => snoozeUntil(choice.until)}>
            <span className="flex-1">
              {choice.label}
              {choice.id === preset && !snooze ? (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  (default)
                </span>
              ) : null}
            </span>
            {choice.hint ? (
              <span className="ml-4 text-xs text-muted-foreground">
                {choice.hint}
              </span>
            ) : null}
          </MenuItem>
        ))}
        <DropdownMenu.Separator className="my-1 h-px bg-border" />
        <MenuItem onSelect={() => setPicking(true)}>
          Pick a date and time…
        </MenuItem>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );

  return (
    <>
      {snooze ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md bg-foreground/[0.07] px-2 text-xs text-muted-foreground hover:bg-foreground/[0.12] hover:text-foreground data-[state=open]:bg-foreground/[0.12] data-[state=open]:text-foreground"
            aria-label={`Snoozed ${describeWake(snooze.until, now)}. Snooze options`}
            title={`Snoozed ${describeWake(snooze.until, now)}`}
          >
            <SnoozeIcon className="size-3.5" />
            {isCompactViewport ? null : shortWake(snooze.until, now)}
          </DropdownMenu.Trigger>
          {menu}
        </DropdownMenu.Root>
      ) : isCompactViewport ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            className={cn(buttonClass, "w-7 rounded-md")}
            aria-label="Snooze options"
            title="Snooze"
          >
            <SnoozeIcon className="size-4" />
          </DropdownMenu.Trigger>
          {menu}
        </DropdownMenu.Root>
      ) : (
        <div className="inline-flex items-center">
          <button
            type="button"
            className={cn(buttonClass, "w-7 rounded-l-md")}
            aria-label={defaultTitle}
            title={defaultTitle}
            onClick={snoozeDefault}
          >
            <SnoozeIcon className="size-4" />
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              className={cn(buttonClass, "w-4 rounded-r-md")}
              aria-label="Snooze options"
              title="Snooze options"
            >
              <Icon name="ChevronDown" className="size-3" />
            </DropdownMenu.Trigger>
            {menu}
          </DropdownMenu.Root>
        </div>
      )}
      <CustomSnoozeDialog
        open={picking}
        onClose={() => setPicking(false)}
        onSubmit={snoozeUntil}
      />
    </>
  );
}

const buttonClass =
  "inline-flex h-7 cursor-pointer items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground";

function MenuItem({
  children,
  onSelect,
}: {
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className="flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
    >
      {children}
    </DropdownMenu.Item>
  );
}
