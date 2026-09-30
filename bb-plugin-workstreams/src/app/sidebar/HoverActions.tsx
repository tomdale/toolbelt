/**
 * The buttons a sidebar row shows on hover: plain actions with a tooltip,
 * and a button whose menu opens when the pointer rests on it.
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

/** A row action with a tooltip naming it. */
export function HoverAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Hint label={label}>
      <HoverButton label={label} onRun={onClick}>
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
  children,
}: {
  label: string;
  onClick: () => void;
  menu: ReactNode;
  children: ReactNode;
}) {
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

const menuItems = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[role="menuitem"]'),
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
 * drag, and clicks so it never opens the row.
 */
const HoverButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { label: string; onRun?: () => void }
>(function HoverButton(
  { label, onRun, className, children, onPointerDown, onClick, ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      aria-label={label}
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
        "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
});
