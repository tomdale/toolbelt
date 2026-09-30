/**
 * The Snooze settings section: what a click on a snooze button does, which
 * choices the sidebar's hover menu offers, and when "morning" is. Every
 * change saves immediately and reaches every open window.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  MORNING_HOURS,
  QUICK_SNOOZE_LIMIT,
  SNOOZE_PRESETS,
  snoozeChoices,
  type SnoozePrefs,
  type SnoozePresetId,
} from "../../domain/snooze.ts";
import { useServerState } from "../useWorkstreams.ts";

const hourLabel = (hour: number) =>
  new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {
    hour: "numeric",
  });

const selectClass =
  "h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function SnoozeSettings() {
  const { server, saveSnoozePrefs } = useServerState();
  const [error, setError] = useState<string | null>(null);
  const prefs = server.snoozePrefs;
  const change = (patch: Partial<SnoozePrefs>) => {
    setError(null);
    saveSnoozePrefs(patch).catch((cause: unknown) =>
      setError(
        cause instanceof Error ? cause.message : "Couldn't save the change.",
      ),
    );
  };
  const hints = new Map(
    snoozeChoices(Date.now(), prefs).map((c) => [c.id, c.hint]),
  );
  const full = prefs.quick.length >= QUICK_SNOOZE_LIMIT;
  const toggleQuick = (id: SnoozePresetId, on: boolean) =>
    change({
      quick: on ? [...prefs.quick, id] : prefs.quick.filter((q) => q !== id),
    });

  return (
    <div className="space-y-5 text-sm">
      <label className="flex items-start justify-between gap-4">
        <span>
          <span className="block font-medium text-foreground">
            Click to snooze
          </span>
          <span className="block text-xs text-muted-foreground">
            What a click on a snooze button does, in the sidebar and the thread
            header.
          </span>
        </span>
        <select
          aria-label="Click to snooze"
          value={prefs.default}
          onChange={(event) =>
            change({ default: event.currentTarget.value as SnoozePresetId })
          }
          className={selectClass}
        >
          {SNOOZE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="m-0 min-w-0 space-y-2 border-0 border-t border-solid border-border p-0 pt-4">
        <legend className="float-left mb-2 w-full p-0 font-medium text-foreground">
          Hover menu
        </legend>
        <p className="text-xs text-muted-foreground">
          Up to {QUICK_SNOOZE_LIMIT} choices that open when you rest the pointer
          on a sidebar row's snooze button. Pick a date and time… is always
          there, and every choice is in the right-click menu.
        </p>
        <ul className="m-0 list-none space-y-1 p-0">
          {SNOOZE_PRESETS.map((preset) => {
            const checked = prefs.quick.includes(preset.id);
            const disabled = !checked && full;
            return (
              <li key={preset.id}>
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5",
                    disabled && "cursor-default opacity-50",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) =>
                      toggleQuick(preset.id, event.currentTarget.checked)
                    }
                    className="h-4 w-4 accent-foreground"
                  />
                  <span className="flex-1 text-foreground">{preset.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {hints.get(preset.id)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <label className="flex items-start justify-between gap-4 border-t border-border pt-4">
        <span>
          <span className="block font-medium text-foreground">Mornings</span>
          <span className="block text-xs text-muted-foreground">
            When Tomorrow morning, This weekend (Saturday), and Next week
            (Monday) wake a thread.
          </span>
        </span>
        <select
          aria-label="Mornings start at"
          value={prefs.morningHour}
          onChange={(event) =>
            change({ morningHour: Number(event.currentTarget.value) })
          }
          className={selectClass}
        >
          {Array.from(
            { length: MORNING_HOURS.max - MORNING_HOURS.min + 1 },
            (_, i) => MORNING_HOURS.min + i,
          ).map((hour) => (
            <option key={hour} value={hour}>
              {hourLabel(hour)}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
