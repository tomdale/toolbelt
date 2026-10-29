import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import {
  describeWake,
  snoozeChoices,
  wakeTime,
  type SnoozePrefs,
  type ThreadSnooze,
} from "../../domain/snooze.ts";
import type { SnoozeDraftKind } from "./RuleFields.tsx";

/** The Custom… submenu: each kind a preset can have, and a one-off date. */
const CUSTOM_ITEMS: readonly { kind: SnoozeDraftKind; label: string }[] = [
  { kind: "duration", label: "For a duration…" },
  { kind: "time", label: "At a time…" },
  { kind: "date", label: "On a date…" },
  { kind: "activity", label: "Until it updates" },
];

/**
 * The snooze choices in a menu: every preset with when it would wake, the
 * Custom… submenu, and, for a snoozed thread, its wake time and Wake now.
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
  /** Opens the Custom… dialog on a kind that needs details. */
  onCustom: (kind: SnoozeDraftKind) => void;
}) {
  const { Item: MenuItem, Label, Separator, Sub } = kit;
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
      <Sub label="Custom…">
        {CUSTOM_ITEMS.map(({ kind, label }) => (
          <MenuItem
            key={kind}
            onSelect={() =>
              kind === "activity" ? onSnooze(null) : onCustom(kind)
            }
          >
            {label}
          </MenuItem>
        ))}
      </Sub>
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
  /** An item that opens `children` as a submenu beside it. */
  Sub: ComponentType<{ label: string; children: ReactNode }>;
};

export const menuItemClass =
  "flex w-full cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-left text-sm outline-none";
const labelClass = "px-2 py-1.5 text-xs text-muted-foreground";
const separatorClass = "my-1 h-px bg-border";

/** A submenu trigger's label with its trailing chevron. */
export function SubLabel({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="flex-1">{children}</span>
      <Icon
        name="ChevronRight"
        className="ml-4 size-3.5 text-muted-foreground"
        aria-hidden="true"
      />
    </>
  );
}

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
  Sub: function DropdownSub({ label, children }) {
    const portalScope = usePortalScopeProps();
    return (
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger
          className={`${menuItemClass} data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=open]:bg-accent`}
        >
          <SubLabel>{label}</SubLabel>
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent
            {...portalScope}
            sideOffset={4}
            collisionPadding={8}
            className={snoozeMenuContentClass}
          >
            {children}
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
    );
  },
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
  Sub: PlainSubmenu,
};

/** How long the pointer rests on a submenu's item before it opens. */
const SUBMENU_OPEN_DELAY_MS = 100;
/** How long a submenu survives the pointer leaving it and its item. */
const SUBMENU_CLOSE_DELAY_MS = 250;

/** A submenu's items, not counting any nested deeper. */
export const ownMenuItems = (menu: HTMLElement) =>
  [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
    (item) => item.parentElement?.closest('[role="menu"]') === menu,
  );

/**
 * A submenu inside a plain menu. It is drawn inside its item's wrapper, so
 * for pointer events it is part of the parent menu: moving into it never
 * counts as leaving that menu. It opens beside the item, on the right unless
 * there is no room. Hovering opens it without moving focus; ArrowRight,
 * Enter, or Space on the item opens it and focuses its first item, and
 * ArrowLeft or Escape inside it closes it and returns focus to the item.
 * The parent menu closes when one of its items is chosen.
 */
function PlainSubmenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ left: false, up: false });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusFirst = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => clearTimeout(timer.current);
  const schedule = (next: boolean, delay: number) => {
    cancel();
    timer.current = setTimeout(() => setOpen(next), delay);
  };
  useEffect(() => cancel, []);

  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const item = trigger.current.getBoundingClientRect();
    const box = menu.current.getBoundingClientRect();
    setPlacement({
      left: item.right + box.width > window.innerWidth - 8,
      up: item.top + box.height > window.innerHeight - 8,
    });
    if (focusFirst.current) {
      focusFirst.current = false;
      ownMenuItems(menu.current)[0]?.focus();
    }
  }, [open]);

  const openFromKeyboard = () => {
    cancel();
    if (open && menu.current) ownMenuItems(menu.current)[0]?.focus();
    else {
      focusFirst.current = true;
      setOpen(true);
    }
  };
  /**
   * The pointer left: close after a moment. Focus inside the submenu goes
   * back to its item first, so the keyboard keeps its place in the menu.
   */
  const closeOnLeave = () => {
    cancel();
    timer.current = setTimeout(() => {
      if (menu.current?.contains(document.activeElement))
        trigger.current?.focus();
      setOpen(false);
    }, SUBMENU_CLOSE_DELAY_MS);
  };
  const closeToTrigger = () => {
    cancel();
    setOpen(false);
    trigger.current?.focus();
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeToTrigger();
      return;
    }
    const items = ownMenuItems(event.currentTarget);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? (at + 1) % items.length
        : event.key === "ArrowUp"
          ? (at - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null;
    if (next === null || !items.length) return;
    event.preventDefault();
    event.stopPropagation();
    items[next]!.focus();
  };

  return (
    <div
      className="relative"
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse")
          schedule(true, open ? 0 : SUBMENU_OPEN_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") closeOnLeave();
      }}
    >
      <button
        ref={trigger}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        data-state={open ? "open" : "closed"}
        onClick={() => {
          cancel();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (
            event.key !== "ArrowRight" &&
            event.key !== "Enter" &&
            event.key !== " "
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          openFromKeyboard();
        }}
        className={cn(plainItemClass, "data-[state=open]:bg-accent")}
      >
        <SubLabel>{label}</SubLabel>
      </button>
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          data-submenu=""
          onKeyDown={onMenuKeyDown}
          className={cn(
            snoozeMenuContentClass,
            "absolute",
            placement.left ? "right-full mr-1" : "left-full ml-1",
            placement.up ? "bottom-0 -mb-1" : "top-0 -mt-1",
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
