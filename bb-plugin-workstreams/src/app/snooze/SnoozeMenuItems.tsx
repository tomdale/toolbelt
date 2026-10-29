import type { ComponentType, ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  describeWake,
  snoozeChoices,
  wakeTime,
  type SnoozePrefs,
  type ThreadSnooze,
} from "../../domain/snooze.ts";

/**
 * The snooze choices in a menu: every preset with when it would wake, the
 * Custom… item, and, for a snoozed thread, its wake time and Wake now.
 * Shared by the thread header's dropdown, the sidebar's hover menus, and the
 * row's right-click menu, which draw items with different primitives (`kit`).
 *
 * `now` only labels the choices; a choice's wake time is worked out when it
 * is chosen, since a menu can sit open, or `now` lag, past a preset's time.
 */
export function SnoozeMenuItems({
  heading,
  now,
  prefs,
  snooze,
  onSnooze,
  onWake,
  onCustom,
  kit = dropdownMenuKit,
}: {
  kit?: MenuKit;
  /** Names what the choices snooze, above them ("Snooze 4 threads"). */
  heading?: string;
  now: number;
  /** The presets to list, and the one-click default, marked while not snoozed. */
  prefs: SnoozePrefs;
  /**
   * The thread's current snooze, which hides the default's mark; with
   * `onWake`, the menu also says when it wakes and offers Wake now.
   */
  snooze?: ThreadSnooze;
  onSnooze: (until: number | null) => void;
  onWake?: () => void;
  /** Opens the Custom… dialog (see `CustomSnoozeDialog`). */
  onCustom: () => void;
}) {
  const { Item: MenuItem, Label, Separator } = kit;
  return (
    <>
      {heading ? <Label>{heading}</Label> : null}
      {snooze && onWake ? (
        <>
          <Label>Snoozed {describeWake(snooze.until, now)}</Label>
          <MenuItem onSelect={onWake}>Wake now</MenuItem>
          <Separator />
        </>
      ) : null}
      {snoozeChoices(prefs.presets, now).map((choice) => (
        <MenuItem
          key={choice.id}
          onSelect={() => onSnooze(wakeTime(choice.rule, Date.now()))}
        >
          <span className="flex-1">
            {choice.label}
            {choice.id === prefs.default && !snooze ? (
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
      <MenuItem onSelect={onCustom}>Custom…</MenuItem>
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

export const menuItemClass =
  "flex w-full cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-left text-sm outline-none";
const labelClass = "px-2 py-1.5 text-xs text-muted-foreground";
const separatorClass = "my-1 h-px bg-border";

/** Items inside a Radix dropdown menu. */
export const dropdownMenuKit: MenuKit = {
  Item: ({ onSelect, children }) => (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={`${menuItemClass} data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground`}
    >
      {children}
    </DropdownMenu.Item>
  ),
  Label: ({ children }) => (
    <DropdownMenu.Label className={labelClass}>{children}</DropdownMenu.Label>
  ),
  Separator: () => <DropdownMenu.Separator className={separatorClass} />,
};

const plainItemClass = `${menuItemClass} border-0 bg-transparent text-inherit hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground`;

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
      className={plainItemClass}
    >
      {children}
    </button>
  ),
  Label: ({ children }) => <div className={labelClass}>{children}</div>,
  Separator: () => <div role="separator" className={separatorClass} />,
};
