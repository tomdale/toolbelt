import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { WORKSTREAM_ICON } from "./workstream-icon.ts";

/**
 * The mark beside a workstream's name, wherever the UI shows a workstream
 * entity: muted, decorative, and sized by the caller's `className`.
 */
export function WorkstreamIcon({ className }: { className?: string }) {
  return (
    <Icon
      name={WORKSTREAM_ICON}
      aria-hidden
      className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
    />
  );
}
