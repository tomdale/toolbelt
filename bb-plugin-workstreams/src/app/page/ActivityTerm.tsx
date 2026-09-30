import * as Tooltip from "@radix-ui/react-tooltip";

export function ActivityTerm({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <Tooltip.Provider delayDuration={150}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              type="button"
              aria-label={`About ${label}`}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span
                aria-hidden="true"
                className="inline-flex size-3.5 items-center justify-center rounded-full border border-current font-serif text-[10px] leading-none"
              >
                i
              </span>
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="top"
              sideOffset={5}
              collisionPadding={12}
              className="z-50 max-w-72 rounded-md border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md"
            >
              {description}
              <Tooltip.Arrow className="fill-popover" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    </span>
  );
}
