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
      <div>
        <SettingRow
          label="Hover menu"
          description={`Choose up to ${QUICK_SNOOZE_LIMIT} options for the sidebar snooze menu. ${prefs.quick.length} of ${QUICK_SNOOZE_LIMIT} chosen; pick a date and time is always available.`}
        />
        <ul aria-label="Hover menu choices" className="mt-2 space-y-1">
          {SNOOZE_PRESETS.map((preset) => {
            const checked = prefs.quick.includes(preset.id);
            const disabled = !checked && full;
            return (
              <li key={preset.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-label={preset.label}
                  aria-checked={checked}
                  data-testid={`quick-snooze-${preset.id}`}
                  aria-disabled={disabled}
                  disabled={disabled}
                  onClick={() => toggleQuick(preset.id, !checked)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors",
                    disabled
                      ? "cursor-not-allowed text-muted-foreground/60"
                      : "cursor-pointer text-foreground hover:bg-accent/50",
                    checked && "bg-accent/30",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded border",
                      checked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground/50",
                    )}
                  >
                    {checked ? (
                      <span className="text-xs leading-none">✓</span>
                    ) : null}
                  </span>
                  <span className="flex-1 text-sm">{preset.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {hints.get(preset.id)}
                  </span>
                </button>
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
