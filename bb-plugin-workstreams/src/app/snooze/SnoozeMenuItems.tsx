import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  describeWake,
  snoozeChoices,
  type SnoozePresetId,
  type ThreadSnooze,
} from "../../domain/snooze.ts";

/**
 * The snooze choices in a dropdown: every preset with when it would wake,
 * the date-and-time picker, and, for a snoozed thread, its wake time and
 * Wake now. Shared by the thread header's and the sidebar row's snooze
 * buttons.
 */
export function SnoozeMenuItems({
  now,
  preset,
  snooze,
  onSnooze,
  onWake,
  onPick,
}: {
  now: number;
  /** The one-click default, labeled as such while the thread isn't snoozed. */
  preset: SnoozePresetId;
  snooze?: ThreadSnooze;
  onSnooze: (until: number | null) => void;
  onWake: () => void;
  onPick: () => void;
}) {
  return (
    <>
      {snooze ? (
        <>
          <DropdownMenu.Label className="px-2 py-1.5 text-xs text-muted-foreground">
            Snoozed {describeWake(snooze.until, now)}
          </DropdownMenu.Label>
          <MenuItem onSelect={onWake}>Wake now</MenuItem>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
        </>
      ) : null}
      {snoozeChoices(now).map((choice) => (
        <MenuItem key={choice.id} onSelect={() => onSnooze(choice.until)}>
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
      <MenuItem onSelect={onPick}>Pick a date and time…</MenuItem>
    </>
  );
}

export const snoozeMenuContentClass =
  "z-50 min-w-60 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md";

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
