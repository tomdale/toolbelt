/**
 * A live preview of the recap card in the chosen layout, as a carousel with
 * one example per recap state.
 */
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Recap } from "../../domain/recap.ts";
import type { RecapLayout } from "../../domain/recapPrefs.ts";
import { RecapCardPreview } from "../composer/RecapCard.tsx";

type Example = {
  label: string;
  recap: Recap;
  showArchive: boolean;
};

const EXAMPLES: readonly Example[] = [
  {
    label: "Complete",
    showArchive: true,
    recap: {
      id: "preview-complete",
      turnId: "preview",
      at: 0,
      state: "complete",
      goal: "Added dark mode to the Settings page",
      latest: [
        "Theme toggle saves to the user's preferences",
        "Every settings panel follows the system theme by default",
        "Shipped in `3f9c2a1e`",
      ],
      review: [],
      links: [],
      next: [
        {
          title: "Run tests",
          message: "Run the full test suite",
          description: "Check for regressions before shipping",
        },
        {
          title: "Open pull request",
          message: "Open a pull request for this change",
        },
      ],
    },
  },
  {
    label: "Ready for review",
    showArchive: false,
    recap: {
      id: "preview-review",
      turnId: "preview",
      at: 0,
      state: "review",
      goal: "Added dark mode to the Settings page",
      latest: [
        "Theme toggle saves to the user's preferences",
        "Every settings panel follows the system theme by default",
      ],
      review: [
        {
          text: "Open Settings → Appearance and choose Dark",
          detail: "Every settings panel should switch to the dark theme",
        },
        {
          text: "Reload Settings",
          detail: "Dark should stay selected after the page reloads",
        },
      ],
      links: [],
      next: [
        {
          title: "Looks good",
          message: "Looks good, merge it",
          description: "Accept the reviewed change",
        },
        {
          title: "Ask a question",
          message: "Why a carousel instead of a list?",
          description: "Ask about the design choice",
        },
      ],
    },
  },
  {
    label: "Waiting",
    showArchive: false,
    recap: {
      id: "preview-waiting",
      turnId: "preview",
      at: Date.now(),
      state: "waiting",
      goal: "Adding dark mode to the Settings page",
      tasks: [
        "UI and server subagents are building the theme toggle",
        "Add accessible keyboard controls",
      ],
      timeout: 120,
      latest: [],
      review: [],
      links: [],
      next: [],
    },
  },
];

const NAV_BUTTON =
  "flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        d={
          direction === "left"
            ? "M10 3.5 5.5 8l4.5 4.5"
            : "M6 3.5 10.5 8 6 12.5"
        }
      />
    </svg>
  );
}

export function RecapPreview({
  layout,
  hashColors,
}: {
  layout: RecapLayout;
  hashColors?: { digits: string | null; letters: string | null };
}) {
  const [index, setIndex] = useState(0);
  const slides = useRef<(HTMLDivElement | null)[]>([]);
  const show = (next: number) => {
    const target = (next + EXAMPLES.length) % EXAMPLES.length;
    if (target === index) return;
    // jsdom and older engines lack the Web Animations API.
    slides.current[target]?.animate?.(
      [
        {
          opacity: 0,
          transform: `translateX(${next > index ? 12 : -12}px)`,
        },
        { opacity: 1, transform: "none" },
      ],
      { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
    setIndex(target);
  };
  const current = EXAMPLES[index]!;
  const controls = (
    <div className="flex items-center justify-center gap-1">
      <button
        type="button"
        className={NAV_BUTTON}
        aria-label="Previous example"
        onClick={() => show(index - 1)}
      >
        <Chevron direction="left" />
      </button>
      {EXAMPLES.map((example, position) => (
        <button
          key={example.label}
          type="button"
          aria-label={`Show ${example.label} example`}
          aria-current={position === index ? "true" : undefined}
          title={example.label}
          onClick={() => show(position)}
          className="flex h-6 cursor-pointer items-center rounded px-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span
            aria-hidden="true"
            className={cn(
              "block h-1.5 rounded-full transition-all",
              position === index
                ? "w-4 bg-foreground/60"
                : "w-1.5 bg-foreground/20",
            )}
          />
        </button>
      ))}
      <button
        type="button"
        className={NAV_BUTTON}
        aria-label="Next example"
        onClick={() => show(index + 1)}
      >
        <Chevron direction="right" />
      </button>
    </div>
  );
  return (
    <section
      aria-roledescription="carousel"
      aria-label="Recap preview"
      className="rounded-lg bg-muted/40 px-3 pt-3 pb-1.5"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") show(index - 1);
        else if (event.key === "ArrowRight") show(index + 1);
        else return;
        event.preventDefault();
      }}
    >
      <p aria-live="polite" className="sr-only">
        {current.label}
      </p>
      {/* Every slide shares one grid cell, so the preview keeps the tallest
          example's height and switching never shifts the page. */}
      <div className="grid">
        {EXAMPLES.map((example, position) => {
          const active = position === index;
          return (
            <div
              key={example.label}
              ref={(node) => {
                slides.current[position] = node;
              }}
              role="group"
              aria-roledescription="slide"
              aria-label={`${position + 1} of ${EXAMPLES.length}: ${example.label}`}
              aria-hidden={active ? undefined : true}
              className={cn(
                "flex min-w-0 flex-col justify-center [grid-area:1/1]",
                !active && "invisible",
              )}
            >
              <RecapCardPreview
                recap={example.recap}
                layout={layout}
                showArchive={example.showArchive}
                hashColors={hashColors}
                className="mb-0"
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5">{controls}</div>
    </section>
  );
}
