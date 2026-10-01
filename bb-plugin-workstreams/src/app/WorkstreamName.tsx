import { cn } from "@/lib/utils";

/**
 * Renders a workstream name, giving colon-prefixed sub-areas ("<Product>: <Area>")
 * a distinct visual treatment where the product anchor is quiet and the area is prominent.
 */
export function WorkstreamName({
  name,
  className,
  muted = false,
}: {
  name: string;
  className?: string;
  muted?: boolean;
}) {
  const colonIdx = name.indexOf(":");
  if (colonIdx > 0 && colonIdx < name.length - 1) {
    const prefix = name.slice(0, colonIdx).trim();
    const suffix = name.slice(colonIdx + 1).trim();
    return (
      <span
        className={cn(
          "inline-flex items-baseline min-w-0 max-w-full truncate",
          className,
        )}
      >
        <span
          className={cn(
            "font-normal shrink-0",
            muted ? "text-muted-foreground/70" : "text-muted-foreground",
          )}
        >
          {prefix}
        </span>
        <span
          className="mx-1 font-normal opacity-40 shrink-0"
          aria-hidden="true"
        >
          :
        </span>
        <span
          className={cn(
            "font-semibold truncate",
            muted ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {suffix}
        </span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "truncate font-semibold",
        muted ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    >
      {name}
    </span>
  );
}
