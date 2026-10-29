/**
 * The buttons a sidebar row shows on hover, shared by thread rows and
 * workstream headers so that every row's actions look, behave, and line up
 * alike: plain actions with a tooltip, and a button whose menu opens when
 * the pointer rests on it, gathered in `RowActions`.
 */
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import { Hint } from "../Hint.tsx";

/** How long the pointer rests on the button before its menu opens. */
export const MENU_OPEN_DELAY_MS = 350;
/** How long the menu survives the pointer leaving it or its button. */
export const MENU_CLOSE_DELAY_MS = 200;

/**
 * Keeps a row action out of sight, and out of the layout so the title keeps
 * its width, until its row (marked `group/row`) is hovered, holds keyboard
 * focus, or has a menu open. Touch screens can't hover, so there it stays
 * hidden.
 */
const REVEAL_ON_ROW_HOVER =
  "max-w-0 overflow-hidden opacity-0 group-hover/row:max-w-6 group-hover/row:opacity-100 group-has-[:focus-visible]/row:max-w-6 group-has-[:focus-visible]/row:opacity-100 group-has-[[data-state=open]]/row:max-w-6 group-has-[[data-state=open]]/row:opacity-100 pointer-coarse:hidden";

/**
 * The look of every sidebar row action, revealed or always shown, and of
 * the section menus beside them: a muted 14px icon in a square that lights
 * up under the pointer and while its menu is open.
 */
export const rowActionClass =
  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground";

/**
 * A row's actions, at its trailing end just before its details (an age or
 * counts). The row is a flex row with `gap-1.5` and the `group/row` class.
 *
 * Every row type orders its actions the same way: toggles (Focus), then
 * creation (New work), then putting the row away (Archive, then Snooze or
 * Wake, which is always last). Each action takes no room until the row is
 * hovered (see `REVEAL_ON_ROW_HOVER`) unless it is `revealed`, as a focused
 * workstream's Focus mark and an empty one's New work are. While nothing in
 * it shows, the negative margin cancels the row's gap.
 */
export function RowActions({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "relative -ml-1.5 flex shrink-0 items-center group-hover/row:ml-0 group-has-[:focus-visible]/row:ml-0 group-has-[[data-state=open]]/row:ml-0 has-[[data-revealed]]:ml-0",
        className,
      )}
    >
      {children}
    </span>
  );
}

type RowActionProps = {
  /** Names the action and its target for assistive technology. */
  label: string;
  onClick: () => void;
  /** Stays in view without hover, on touch screens too. */
  revealed?: boolean;
  /** Sized for a workstream header, whose row is shorter than a thread's. */
  compact?: boolean;
  /** Adjusts the button's look, as a pressed Focus button's color. */
  className?: string;
  children: ReactNode;
};

/**
 * A row action with a tooltip naming it: `hint`, or the label when no
 * shorter name suits ("Focus" for "Focus on Alpha").
 */
export function HoverAction({
  label,
  hint = label,
  onClick,
  revealed,
  compact,
  className,
  pressed,
  children,
}: RowActionProps & {
  hint?: string;
  /** Makes the action a toggle, currently on or off. */
  pressed?: boolean;
}) {
  return (
    <Hint label={hint}>
      <HoverButton
        label={label}
        revealed={revealed}
        compact={compact}
        className={className}
        aria-pressed={pressed}
        onRun={onClick}
      >
        {children}
      </HoverButton>
    </Hint>
  );
}

/**
 * A row button whose click runs `onClick` and whose hover opens `menu`
 * above it (below when there's no room). The menu opens only once the
 * pointer rests on the button, so passing over it does nothing, and stays
 * open while the pointer travels from the button into it. From the
 * keyboard, Enter runs `onClick` and ArrowDown opens the menu.
 *
 * `menu` is a list of `role="menuitem"` buttons (see `plainMenuKit`);
 * choosing one closes the menu. A hover-opened menu leaves focus where it
 * was, say in the composer, when it opens and closes. A keyboard-opened one
 * moves focus to its first item and back to the button on close.
 */
export function HoverMenuButton({
  label,
  onClick,
  menu,
  revealed,
  compact,
  className,
  children,
}: RowActionProps & { menu: ReactNode }) {
  const portalScope = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  const byKeyboard = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => clearTimeout(timer.current);
  const schedule = (next: boolean, delay: number) => {
    cancel();
    timer.current = setTimeout(() => setOpen(next), delay);
  };
  useEffect(() => cancel, []);
  const close = () => {
    cancel();
    setOpen(false);
    if (byKeyboard.current) button.current?.focus();
    byKeyboard.current = false;
  };
  const mouse = (event: { pointerType: string }) =>
    event.pointerType === "mouse";

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? null : close())}>
      <Popover.Anchor asChild>
        <HoverButton
          ref={button}
          label={label}
          revealed={revealed}
          compact={compact}
          className={className}
          aria-haspopup="menu"
          aria-expanded={open}
          data-state={open ? "open" : "closed"}
          onRun={() => {
            close();
            onClick();
          }}
          onPointerEnter={(event) => {
            if (!mouse(event)) return;
            byKeyboard.current = false;
            schedule(true, open ? 0 : MENU_OPEN_DELAY_MS);
          }}
          onPointerLeave={(event) => {
            if (mouse(event)) schedule(false, MENU_CLOSE_DELAY_MS);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            byKeyboard.current = true;
            cancel();
            setOpen(true);
          }}
        >
          {children}
        </HoverButton>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          {...portalScope}
          role="menu"
          aria-label={label}
          side="top"
          align="end"
          sideOffset={2}
          collisionPadding={8}
          className="z-50 min-w-60 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none"
          onPointerEnter={cancel}
          onPointerLeave={(event) => {
            if (mouse(event)) schedule(false, MENU_CLOSE_DELAY_MS);
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (byKeyboard.current)
              menuItems(event.currentTarget as HTMLElement)[0]?.focus();
          }}
          // `close` returns focus itself, only for a keyboard-opened menu.
          onCloseAutoFocus={(event) => event.preventDefault()}
          onKeyDown={moveFocus}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('[role="menuitem"]'))
              close();
          }}
        >
          {menu}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const menuItems = (menu: HTMLElement) => [
  ...menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];

/** Arrow keys, Home, and End move between a menu's items. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  const items = menuItems(event.currentTarget);
  if (!items.length) return;
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
  if (next === null) return;
  event.preventDefault();
  items[next]!.focus();
}

/**
 * The button itself. It stops pointer and mouse downs so it never starts a
 * drag (of the row, or of the workstream a header leads), and clicks so it
 * never opens the row or folds the workstream.
 */
const HoverButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & {
    label: string;
    revealed?: boolean;
    compact?: boolean;
    onRun?: () => void;
  }
>(function HoverButton(
  {
    label,
    revealed,
    compact,
    onRun,
    className,
    children,
    onPointerDown,
    onClick,
    ...rest
  },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      aria-label={label}
      data-revealed={revealed ? "" : undefined}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick?.(event);
        onRun?.();
      }}
      className={cn(
        rowActionClass,
        compact && "size-5",
        !revealed && REVEAL_ON_ROW_HOVER,
        className,
      )}
    >
      {children}
    </button>
  );
});
