/**
 * The Recap settings section: whether agents end each turn with a recap,
 * how many reminders a turn without one gets, and the card's layout as
 * picture cards. Every change saves immediately.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  CORRECTIONS,
  RECAP_LAYOUT_OPTIONS,
  type RecapLayout,
  type RecapPrefs,
} from "../../domain/recapPrefs.ts";
import { useRecapPrefs } from "./prefs.ts";

/** A schematic of each layout, drawn with the recap card's own proportions. */
function LayoutPreview({ layout }: { layout: RecapLayout }) {
  const bar = "rounded-full bg-sky-900/15 dark:bg-sky-200/20";
  return (
    <div
      aria-hidden="true"
      className="flex h-14 flex-col justify-center rounded-md border border-sky-400 bg-sky-50/40 px-2.5 dark:border-sky-500/80 dark:bg-[color-mix(in_oklab,var(--background)_85%,oklch(29.3%_0.066_243.157))]"
    >
      {layout === "full" ? (
        <div
          className={`mb-2 h-1.5 w-1/2 ${bar} !bg-sky-900/30 dark:!bg-sky-200/35`}
        />
      ) : null}
      <div className="space-y-1">
        <div className={`h-1 w-full ${bar}`} />
        <div className={`h-1 w-3/4 ${bar}`} />
      </div>
      <div className="mt-2 flex justify-center gap-1">
        <div className={`h-1.5 w-5 ${bar}`} />
        <div className={`h-1.5 w-5 ${bar}`} />
      </div>
    </div>
  );
}

/**
 * A whole-number field that commits each valid keystroke, clamped to its
 * range, and shows the stored value again when it loses focus.
 */
function BoundedNumberInput({
  label,
  value,
  range,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  range: { min: number; max: number };
  disabled?: boolean;
  onCommit: (next: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={text ?? String(value)}
      disabled={disabled}
      onChange={(event) => {
        const raw = event.currentTarget.value;
        setText(raw);
        if (/^\d+$/.test(raw.trim()))
          onCommit(Math.min(range.max, Math.max(range.min, Number(raw))));
      }}
      onBlur={() => setText(null)}
      className="h-8 w-24 rounded-md border border-border bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

export function RecapSettings() {
  const { prefs, save } = useRecapPrefs();
  const [error, setError] = useState<string | null>(null);
  if (!prefs)
    return (
      <p className="text-xs text-muted-foreground">Loading recap settings…</p>
    );
  const change = (patch: Partial<RecapPrefs>) => {
    setError(null);
    save(patch).catch((cause) =>
      setError(
        cause instanceof Error ? cause.message : "Couldn't save the change.",
      ),
    );
  };
  return (
    <div className="space-y-5 text-sm">
      <div
        role="radiogroup"
        aria-labelledby="ws-recap-layout"
        className="space-y-2"
      >
        <p id="ws-recap-layout" className="font-medium text-foreground">
          Layout
        </p>
        <p className="text-xs text-muted-foreground">
          How much of each recap to show above the composer.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {RECAP_LAYOUT_OPTIONS.map((option) => {
            const selected = option.value === prefs.layout;
            return (
              <label
                key={option.value}
                className={cn(
                  "relative flex cursor-pointer flex-col gap-2 rounded-lg border p-2.5 transition-colors",
                  selected
                    ? "border-foreground/60 bg-accent/40"
                    : "border-border hover:bg-accent/20",
                )}
              >
                <LayoutPreview layout={option.value} />
                <span className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="ws-recap-layout"
                    value={option.value}
                    checked={selected}
                    onChange={() => change({ layout: option.value })}
                    className="mt-0.5 accent-foreground"
                  />
                  <span>
                    <span className="block font-medium text-foreground">
                      {option.label}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
        <div>
          <p className="font-medium text-foreground">End turns with a recap</p>
          <p className="text-xs text-muted-foreground">
            {prefs.required
              ? "Agents report each turn as complete or ready for review, or ask through a question card. Applies to each thread's next session."
              : "Off: agents don't get the recap tool, and threads show no recap card."}
          </p>
        </div>
        <input
          type="checkbox"
          aria-label="End turns with a recap"
          checked={prefs.required}
          onChange={(event) =>
            change({ required: event.currentTarget.checked })
          }
          className="mt-0.5 h-4 w-4 cursor-pointer accent-foreground"
        />
      </div>
      <label
        className={cn(
          "block space-y-1.5 transition-opacity",
          !prefs.required && "opacity-50",
        )}
      >
        <span className="block font-medium text-foreground">Reminders</span>
        <span className="block text-xs text-muted-foreground">
          How many times to remind an agent that ends a turn without a recap (
          {CORRECTIONS.min}–{CORRECTIONS.max}; 0 never reminds).
        </span>
        <BoundedNumberInput
          label="Reminders per turn"
          value={prefs.corrections}
          range={CORRECTIONS}
          disabled={!prefs.required}
          onCommit={(corrections) => change({ corrections })}
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
