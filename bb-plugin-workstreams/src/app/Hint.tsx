import {
  forwardRef,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactElement,
} from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { isLastInputKeyboard } from "@/components/ui/overlay-trigger";
import { usePortalScopeProps } from "@/lib/portal-scope";

/**
 * A small tooltip naming one icon control: popover-colored, one line, no
 * motion. It opens on hover, or on focus only when the focus came from the
 * keyboard.
 *
 * Extra props reach the control, so a menu trigger can wrap it with
 * `asChild`: the menu's `data-state` then wins over the tooltip's, and the
 * tooltip stays closed while that menu is open.
 */
export const Hint = forwardRef<
  ElementRef<typeof TooltipPrimitive.Trigger>,
  Omit<
    ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>,
    "children"
  > & {
    label: string;
    side?: "top" | "right" | "bottom" | "left";
    children: ReactElement;
  }
>(function Hint(
  { label, side = "top", children, onFocus, onBlur, onPointerLeave, ...rest },
  ref,
) {
  const portalScope = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  const menuOpen = (rest as { "data-state"?: string })["data-state"] === "open";
  // A menu's open and close both silence the tooltip: it forgets a hover
  // from before the menu opened, and ignores the focus the menu hands back
  // on close, until the pointer leaves or focus moves on.
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    setOpen(false);
    setQuiet(true);
  }, [menuOpen]);
  return (
    <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={200}>
      <TooltipPrimitive.Root
        open={open && !menuOpen && !quiet}
        onOpenChange={setOpen}
      >
        <TooltipPrimitive.Trigger
          asChild
          ref={ref}
          {...rest}
          onBlur={(event) => {
            onBlur?.(event);
            if (!menuOpen) setQuiet(false);
          }}
          onPointerLeave={(event) => {
            onPointerLeave?.(event);
            if (!menuOpen) setQuiet(false);
          }}
          onFocus={(event) => {
            onFocus?.(event);
            if (!event.defaultPrevented && !isLastInputKeyboard())
              event.preventDefault();
          }}
        >
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            {...portalScope}
            side={side}
            sideOffset={4}
            collisionPadding={8}
            className="z-50 max-w-64 rounded-md border border-border bg-popover px-2 py-1 text-[11px] leading-4 text-popover-foreground shadow-md"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
});
