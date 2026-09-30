import type { ComponentType, ReactNode } from "react";
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
 * Wake now. Shared by the thread header's dropdown and the sidebar row's
 * hover menu, which draw items with different primitives (`kit`).
 */
export function SnoozeMenuItems({
  now,
  preset,
  morningHour,
  only,
  snooze,
  onSnooze,
  onWake,
  onPick,
  kit = dropdownMenuKit,
}: {
  kit?: MenuKit;
  now: number;
  /** The one-click default, labeled as such while the thread isn't snoozed. */
  preset: SnoozePresetId;
  morningHour: number;
  /** Limits the list to these choices (the sidebar's quick choices). */
  only?: readonly SnoozePresetId[];
  snooze?: ThreadSnooze;
  onSnooze: (until: number | null) => void;
  onWake: () => void;
  onPick: () => void;
}) {
  const { Item: MenuItem, Label, Separator } = kit;
  return (
    <>
      {snooze ? (
        <>
          <Label>Snoozed {describeWake(snooze.until, now)}</Label>
          <MenuItem onSelect={onWake}>Wake now</MenuItem>
          <Separator />
        </>
      ) : null}
      {snoozeChoices(now, { morningHour, only }).map((choice) => (
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
      <Separator />
      <MenuItem onSelect={onPick}>Pick a date and time…</MenuItem>
    </>
  );
}

export const snoozeMenuContentClass =
  "z-50 min-w-60 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md";

/** The item primitives a snooze menu is drawn with. */
export type MenuKit = {
  Item: ComponentType<{ onSelect: () => void; children: ReactNode }>;
  Label: ComponentType<{ children: ReactNode }>;
  Separator: ComponentType;
};

const itemClass =
  "flex w-full cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-left text-sm outline-none";
const labelClass = "px-2 py-1.5 text-xs text-muted-foreground";
const separatorClass = "my-1 h-px bg-border";

/** Items inside a Radix dropdown menu. */
export const dropdownMenuKit: MenuKit = {
  Item: ({ onSelect, children }) => (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={`${itemClass} data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground`}
    >
      {children}
    </DropdownMenu.Item>
  ),
  Label: ({ children }) => (
    <DropdownMenu.Label className={labelClass}>{children}</DropdownMenu.Label>
  ),
  Separator: () => <DropdownMenu.Separator className={separatorClass} />,
};

/**
 * Plain `role="menuitem"` buttons, for a menu that manages its own focus
 * (the sidebar's hover menu). Hover and focus both highlight an item.
 */
export const plainMenuKit: MenuKit = {
  Item: ({ onSelect, children }) => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={onSelect}
      className={`${itemClass} border-0 bg-transparent text-inherit hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground`}
    >
      {children}
    </button>
  ),
  Label: ({ children }) => <div className={labelClass}>{children}</div>,
  Separator: () => <div role="separator" className={separatorClass} />,
};
