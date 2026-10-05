import * as Tooltip from "@radix-ui/react-tooltip";

/**
 * A term with an explanatory tooltip. `quiet` hides the info button until
 * its Activity row is hovered or focused, so a long log stays calm.
 */
export function ActivityTerm({
  label,
  description,
  quiet = false,
}: {
  label: string;
  description: string;
  quiet?: boolean;
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
              className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring${quiet ? " opacity-0 focus-visible:opacity-100 group-hover/entry:opacity-100" : ""}`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                fill="none"
                className="size-4"
              >
                <circle cx="8" cy="8" r="6.25" stroke="currentColor" />
                <path
                  d="M8 7.25v4M8 4.75h.01"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="1.5"
                />
              </svg>
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
