/**
 * The Recap settings section: whether agents end each turn with a recap,
 * how many reminders a turn without one gets, and the card's layout, with a
 * live preview of the card. Every change saves immediately.
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
import { RecapPreview } from "./RecapPreview.tsx";

/**
 * An abstract glyph of each layout: a heading bar over body lines for Full,
 * body lines alone for Minimal. The preview below shows the real card.
 */
function LayoutGlyph({ layout }: { layout: RecapLayout }) {
  const line = "h-[3px] rounded-full bg-current";
  return (
    <div
      aria-hidden="true"
      className="flex h-9 w-14 flex-col justify-center gap-[3px] rounded-[5px] border border-current/40 px-2"
    >
      {layout === "full" ? (
        <div className={`${line} mb-[2px] h-[4px] w-3/5 opacity-90`} />
      ) : null}
      <div className={`${line} w-full opacity-40`} />
      <div className={`${line} w-4/5 opacity-40`} />
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
    <div className="space-y-4 text-sm">
      <div className="flex items-start justify-between gap-4">
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
          "flex items-start justify-between gap-4 border-t border-border pt-4 transition-opacity",
          !prefs.required && "opacity-50",
        )}
      >
        <span>
          <span className="block font-medium text-foreground">Reminders</span>
          <span className="block text-xs text-muted-foreground">
            How many times to remind an agent that ends a turn without a recap (
            {CORRECTIONS.min}–{CORRECTIONS.max}; 0 never reminds).
          </span>
        </span>
        <BoundedNumberInput
          label="Reminders per turn"
          value={prefs.corrections}
          range={CORRECTIONS}
          disabled={!prefs.required}
          onCommit={(corrections) => change({ corrections })}
        />
      </label>
      <div className="space-y-3 border-t border-border pt-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div>
            <p id="ws-recap-layout" className="font-medium text-foreground">
              Layout
            </p>
            <p className="text-xs text-muted-foreground">
              How much of each recap to show above the composer.
            </p>
          </div>
          <div
            role="radiogroup"
            aria-labelledby="ws-recap-layout"
            className="flex gap-2"
          >
            {RECAP_LAYOUT_OPTIONS.map((option) => {
              const selected = option.value === prefs.layout;
              return (
                <label
                  key={option.value}
                  title={option.description}
                  className={cn(
                    "flex cursor-pointer flex-col items-center gap-1.5 rounded-md p-1.5 text-xs transition-colors has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
                    selected
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <LayoutGlyph layout={option.value} />
                  <input
                    type="radio"
                    name="ws-recap-layout"
                    value={option.value}
                    checked={selected}
                    onChange={() => change({ layout: option.value })}
                    className="sr-only"
                  />
                  <span className="font-medium">{option.label}</span>
                </label>
              );
            })}
          </div>
        </div>
        <RecapPreview layout={prefs.layout} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
