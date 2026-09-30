/**
 * The Recap settings section: the layout as picture cards, the automatic
 * switch, and the automatic timing. Every change saves immediately; existing
 * recaps are not regenerated.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  MIN_TURNS,
  QUIET_SECONDS,
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
      {layout !== "minimal" ? (
        <div
          className={`mb-2 h-1.5 w-1/2 ${bar} !bg-sky-900/30 dark:!bg-sky-200/35`}
        />
      ) : null}
      <div
        className={cn(
          "grid gap-2",
          layout === "detailed" && "grid-cols-[1.2fr_1fr]",
        )}
      >
        <div className="space-y-1">
          <div className={`h-1 w-full ${bar}`} />
          <div className={`h-1 w-3/4 ${bar}`} />
        </div>
        {layout === "detailed" ? (
          <div className="space-y-1 border-l border-sky-900/10 pl-2 dark:border-sky-200/10">
            <div className={`h-1 w-5/6 ${bar}`} />
            <div className={`h-1 w-2/3 ${bar}`} />
          </div>
        ) : null}
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
        <div className="grid gap-2 sm:grid-cols-3">
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
          <p className="font-medium text-foreground">Automatic recaps</p>
          <p className="text-xs text-muted-foreground">
            {prefs.automatic
              ? "Recap a thread above the composer once it has been quiet."
              : "Off: a Generate Recap button appears above the composer instead."}
          </p>
        </div>
        <input
          type="checkbox"
          aria-label="Automatic recaps"
          checked={prefs.automatic}
          onChange={(event) =>
            change({ automatic: event.currentTarget.checked })
          }
          className="mt-0.5 h-4 w-4 cursor-pointer accent-foreground"
        />
      </div>
      <div
        className={cn(
          "grid gap-4 transition-opacity sm:grid-cols-2",
          !prefs.automatic && "opacity-50",
        )}
      >
        <label className="space-y-1.5">
          <span className="block font-medium text-foreground">
            Quiet period
          </span>
          <span className="block text-xs text-muted-foreground">
            Seconds a thread stays idle before it's recapped (
            {QUIET_SECONDS.min}–{QUIET_SECONDS.max}).
          </span>
          <BoundedNumberInput
            label="Quiet period in seconds"
            value={prefs.quietSeconds}
            range={QUIET_SECONDS}
            disabled={!prefs.automatic}
            onCommit={(quietSeconds) => change({ quietSeconds })}
          />
        </label>
        <label className="space-y-1.5">
          <span className="block font-medium text-foreground">
            Minimum messages
          </span>
          <span className="block text-xs text-muted-foreground">
            Your messages a thread needs before automatic recaps start (
            {MIN_TURNS.min}–{MIN_TURNS.max}). Generate Recap works on any
            thread.
          </span>
          <BoundedNumberInput
            label="Minimum messages"
            value={prefs.minTurns}
            range={MIN_TURNS}
            disabled={!prefs.automatic}
            onCommit={(minTurns) => change({ minTurns })}
          />
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
