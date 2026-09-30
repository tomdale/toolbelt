import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactElement,
} from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * BB's tooltip around one control, for icon buttons whose name would
 * otherwise only reach screen readers. Carries its own provider, so it works
 * in any slot.
 *
 * Extra props reach the control, so a menu trigger can wrap it with `asChild`:
 * the menu's `data-state` then wins over the tooltip's, and open-menu styling
 * keeps working.
 */
export const Hint = forwardRef<
  ElementRef<typeof TooltipTrigger>,
  Omit<ComponentPropsWithoutRef<typeof TooltipTrigger>, "children"> & {
    label: string;
    side?: "top" | "right" | "bottom" | "left";
    children: ReactElement;
  }
>(function Hint({ label, side = "top", children, ...rest }, ref) {
  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild ref={ref} {...rest}>
          {children}
        </TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});
