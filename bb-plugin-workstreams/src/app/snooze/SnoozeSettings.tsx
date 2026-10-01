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
import { SectionRows, SettingRow, SettingsPicker } from "../settings/ui.tsx";
import { useServerState } from "../useWorkstreams.ts";

const hourLabel = (hour: number) =>
  new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });

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
    snoozeChoices(Date.now(), prefs).map((choice) => [choice.id, choice.hint]),
  );
  const full = prefs.quick.length >= QUICK_SNOOZE_LIMIT;
  const toggleQuick = (id: SnoozePresetId, on: boolean) =>
    change({
      quick: on
        ? [...prefs.quick, id]
        : prefs.quick.filter((quick) => quick !== id),
    });

  return (
    <SectionRows>
      <SettingRow
        label="Click to snooze"
        description="What a click on a snooze button does in the sidebar and thread header."
        control={
          <SettingsPicker
            label="Click to snooze"
            value={prefs.default}
            options={SNOOZE_PRESETS.map(({ id, label }) => ({
              value: id,
              label,
            }))}
            onChange={(value) => change({ default: value as SnoozePresetId })}
            className="w-52"
          />
        }
      />
      <div className="py-4 first:pt-0 last:pb-0">
        <SettingRow
          label="Hover menu"
          description={`Choose up to ${QUICK_SNOOZE_LIMIT} options for the sidebar snooze menu. Pick a date and time is always available.`}
          stacked
        />
        <ul className="mt-2 space-y-0.5">
          {SNOOZE_PRESETS.map((preset) => {
            const checked = prefs.quick.includes(preset.id);
            const disabled = !checked && full;
            return (
              <li key={preset.id}>
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50",
                    disabled && "cursor-default opacity-50",
                  )}
                >
                  <input
                    type="checkbox"
                    aria-label={preset.label}
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) =>
                      toggleQuick(preset.id, event.currentTarget.checked)
                    }
                    className="size-4 accent-primary"
                  />
                  <span className="flex-1 text-sm text-foreground">
                    {preset.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {hints.get(preset.id)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>
      <SettingRow
        label="Mornings start at"
        description="When Tomorrow morning, This weekend, and Next week wake a thread."
        control={
          <SettingsPicker
            label="Mornings start at"
            value={String(prefs.morningHour)}
            options={Array.from(
              { length: MORNING_HOURS.max - MORNING_HOURS.min + 1 },
              (_, index) => MORNING_HOURS.min + index,
            ).map((hour) => ({ value: String(hour), label: hourLabel(hour) }))}
            onChange={(value) => change({ morningHour: Number(value) })}
            className="w-32"
          />
        }
      />
      {error ? (
        <p role="alert" className="py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SectionRows>
  );
}
