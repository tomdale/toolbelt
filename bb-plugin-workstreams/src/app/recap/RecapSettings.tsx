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
import { SectionRows, SettingRow, SettingSwitch } from "../settings/ui.tsx";

function LayoutGlyph({ layout }: { layout: RecapLayout }) {
  const line = "h-[3px] rounded-full bg-current";
  return (
    <div
      aria-hidden="true"
      className="flex h-10 w-16 flex-col justify-center gap-[3px] rounded-md border border-current/40 px-2"
    >
      {layout === "full" ? (
        <div className={`${line} mb-[2px] h-[4px] w-3/5 opacity-90`} />
      ) : null}
      <div className={`${line} w-full opacity-40`} />
      <div className={`${line} w-4/5 opacity-40`} />
    </div>
  );
}

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
    <SectionRows>
      <SettingRow
        label="End turns with a recap"
        description={
          prefs.required
            ? "Agents report each turn as complete or ready for review, or ask through a question card. Applies to each thread's next session."
            : "Off: agents don't get the recap tool, and threads show no recap card."
        }
        control={
          <SettingSwitch
            label="End turns with a recap"
            checked={prefs.required}
            onChange={(required) => change({ required })}
          />
        }
      />
      <div
        className={cn(
          "py-4 first:pt-0 last:pb-0",
          !prefs.required && "opacity-50",
        )}
      >
        <SettingRow
          label="Reminders"
          description={`How many times to remind an agent that ends a turn without a recap (${CORRECTIONS.min}–${CORRECTIONS.max}; 0 never reminds).`}
          control={
            <BoundedNumberInput
              label="Reminders per turn"
              value={prefs.corrections}
              range={CORRECTIONS}
              disabled={!prefs.required}
              onCommit={(corrections) => change({ corrections })}
            />
          }
        />
      </div>
      <div className="space-y-3 py-4 first:pt-0 last:pb-0">
        <p id="ws-recap-layout" className="text-sm font-medium text-foreground">
          Layout
        </p>
        <div
          role="radiogroup"
          aria-labelledby="ws-recap-layout"
          className="flex flex-wrap gap-3"
        >
          {RECAP_LAYOUT_OPTIONS.map((option) => {
            const selected = option.value === prefs.layout;
            return (
              <label
                key={option.value}
                title={option.description}
                className={cn(
                  "flex min-w-28 cursor-pointer flex-col items-center gap-2 rounded-lg border px-4 py-3 text-sm transition-colors has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
                  selected
                    ? "border-primary/50 bg-accent text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
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
        <RecapPreview layout={prefs.layout} />
      </div>
      {error ? (
        <p role="alert" className="py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SectionRows>
  );
}
