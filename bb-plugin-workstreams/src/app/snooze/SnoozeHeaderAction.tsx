/**
 * Snooze in the thread header: a split button whose face snoozes with the
 * default preset (the Snooze settings section) and whose arrow lists every
 * preset and Custom…. A snoozed thread shows when it wakes instead, with Wake now in its
 * menu. BB's own thread menu takes no plugin items, so this is the header's
 * snooze entry point, alongside the command palette.
 */
import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  experimental_useSidebarThreads,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import {
  defaultPreset,
  describeWake,
  isSnoozed,
  shortWake,
  wakeTime,
} from "../../domain/snooze.ts";
import { useNow, useServerState } from "../useWorkstreams.ts";
import { snoozeThreads, wakeThreads } from "./actions.ts";
import { CustomSnoozeDialog } from "./CustomSnoozeDialog.tsx";
import type { SnoozeDraftKind } from "./RuleFields.tsx";
import { SnoozeIcon } from "./icons.tsx";
import { SnoozeMenuItems, snoozeMenuContentClass } from "./SnoozeMenuItems.tsx";
import { Hint } from "../Hint.tsx";

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
  const { server, setSnoozes } = useServerState();
  const { threads } = experimental_useSidebarThreads({
    experimental_lifecycles: ["active"],
  });
  const portalScope = usePortalScopeProps();
  const [custom, setCustom] = useState<SnoozeDraftKind | null>(null);
  const thread = threads.find((t) => t.id === threadId);
  const prefs = server.snoozePrefs;
  const preset = defaultPreset(prefs);
  const now = useNow();
  const stored = server.snoozes[threadId];
  const snooze = thread && isSnoozed(stored, thread, now) ? stored : undefined;

  const snoozeUntil = (until: number | null) => {
    if (thread)
      snoozeThreads(setSnoozes, [thread], until, { previous: () => snooze });
  };
  const snoozeDefault = () => snoozeUntil(wakeTime(preset.rule, Date.now()));
  const wake = () => {
    if (thread) wakeThreads(setSnoozes, [thread]);
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

  const defaultTitle = `Snooze ${describeWake(wakeTime(preset.rule, now), now)}`;
  const menu = (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        {...portalScope}
        align="end"
        sideOffset={4}
        className={snoozeMenuContentClass}
      >
        <SnoozeMenuItems
          now={now}
          prefs={prefs}
          snooze={snooze}
          onSnooze={snoozeUntil}
          onWake={wake}
          onCustom={setCustom}
        />
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );

  return (
    <>
      {snooze ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Hint
              label={`Snoozed ${describeWake(snooze.until, now)}`}
              side="bottom"
            >
              <button
                type="button"
                className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md bg-foreground/[0.07] px-2 text-xs text-muted-foreground hover:bg-foreground/[0.12] hover:text-foreground data-[state=open]:bg-foreground/[0.12] data-[state=open]:text-foreground"
                aria-label={`Snoozed ${describeWake(snooze.until, now)}. Snooze options`}
              >
                <SnoozeIcon className="size-3.5" />
                {isCompactViewport ? null : shortWake(snooze.until, now)}
              </button>
            </Hint>
          </DropdownMenu.Trigger>
          {menu}
        </DropdownMenu.Root>
      ) : isCompactViewport ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            className={cn(buttonClass, "w-7 rounded-md")}
            aria-label="Snooze options"
          >
            <SnoozeIcon className="size-4" />
          </DropdownMenu.Trigger>
          {menu}
        </DropdownMenu.Root>
      ) : (
        <div className="inline-flex items-center">
          <Hint label={defaultTitle} side="bottom">
            <button
              type="button"
              className={cn(buttonClass, "w-7 rounded-l-md")}
              aria-label={defaultTitle}
              onClick={snoozeDefault}
            >
              <SnoozeIcon className="size-4" />
            </button>
          </Hint>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Hint label="More snooze options" side="bottom">
                <button
                  type="button"
                  className={cn(buttonClass, "w-4 rounded-r-md")}
                  aria-label="Snooze options"
                >
                  <Icon name="ChevronDown" className="size-3" />
                </button>
              </Hint>
            </DropdownMenu.Trigger>
            {menu}
          </DropdownMenu.Root>
        </div>
      )}
      <CustomSnoozeDialog
        open={custom !== null}
        kind={custom ?? undefined}
        onClose={() => setCustom(null)}
        onSubmit={snoozeUntil}
      />
    </>
  );
}

const buttonClass =
  "inline-flex h-7 cursor-pointer items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground";
