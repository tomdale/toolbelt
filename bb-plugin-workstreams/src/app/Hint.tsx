import {
  forwardRef,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactElement,
  type ReactNode,
} from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { isLastInputKeyboard } from "@/components/ui/overlay-trigger";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";

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
    label: ReactNode;
    side?: "top" | "right" | "bottom" | "left";
    /** Point the hint at its control, for hints that explain a labeled button. */
    arrow?: boolean;
    children: ReactElement;
  }
>(function Hint(
  {
    label,
    side = "top",
    arrow = false,
    children,
    onFocus,
    onBlur,
    onPointerLeave,
    ...rest
  },
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
            className={cn(
              "z-50 max-w-64 rounded-md border border-border bg-popover px-2 py-1 text-[11px] leading-4 text-popover-foreground",
              // A hint that explains a button lands over the recap's own text,
              // so a broad, soft shadow darkens that text enough to read against.
              arrow
                ? "shadow-[0_8px_36px_12px_rgb(0_0_0/0.4)] dark:shadow-[0_8px_36px_14px_rgb(0_0_0/0.95)]"
                : "shadow-md",
            )}
          >
            {label}
            {arrow ? (
              <TooltipPrimitive.Arrow width={10} height={5} asChild>
                <svg viewBox="0 0 10 5" className="overflow-visible">
                  <path d="M-.5 -1H10.5L5 5Z" className="fill-popover" />
                  <path
                    d="M0 0L5 5L10 0"
                    className="fill-none stroke-border"
                    strokeWidth={1}
                  />
                </svg>
              </TooltipPrimitive.Arrow>
            ) : null}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
});
