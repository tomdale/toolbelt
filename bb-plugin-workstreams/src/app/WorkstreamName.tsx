import { cn } from "@/lib/utils";

/** Splits "<Owner>: <Area>" into its parts; null for a plain name. */
export function splitWorkstreamName(
  name: string,
): { owner: string; area: string } | null {
  const at = name.indexOf(":");
  if (at <= 0) return null;
  const owner = name.slice(0, at).trim();
  const area = name.slice(at + 1).trim();
  return owner && area ? { owner, area } : null;
}

/**
 * A workstream's name. An area of a larger product ("Workstreams: Recaps")
 * shows the owner subdued before the area, without the colon; the colon is
 * kept in the accessible text so screen readers hear the full name.
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
  const parts = splitWorkstreamName(name);
  if (!parts)
    return (
      <span
        className={cn(
          "truncate",
          muted ? "text-muted-foreground" : "text-foreground",
          className,
        )}
      >
        {name}
      </span>
    );
  return (
    <span className={cn("truncate", className)}>
      <span className="font-normal text-muted-foreground/60">
        {parts.owner}
      </span>
      <span className="sr-only">:</span>{" "}
      <span className={muted ? "text-muted-foreground" : "text-foreground"}>
        {parts.area}
      </span>
    </span>
  );
}
