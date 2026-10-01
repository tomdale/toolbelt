import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { gatewayModel, type ModelChoice } from "../../domain/prefs.ts";
import { SettingRow } from "./ui.tsx";

const pickerValue = (
  choice: ModelChoice,
): ExperimentalProviderModelPickerValue =>
  choice.kind === "gateway"
    ? {
        providerId: "pi",
        model: `vercel-ai-gateway/${choice.model}`,
        reasoningLevel: "none",
      }
    : {
        providerId: choice.providerId,
        model: choice.model,
        reasoningLevel:
          choice.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"],
        ...(choice.serviceTier
          ? {
              serviceTier:
                choice.serviceTier as ExperimentalProviderModelPickerValue["serviceTier"],
            }
          : {}),
      };

export function ModelField({
  label,
  choice,
  onChange,
  disabled = false,
}: {
  label: string;
  choice: ModelChoice;
  onChange(choice: ModelChoice): void;
  disabled?: boolean;
}) {
  const directModel = gatewayModel(choice);
  const selected = pickerValue(choice);
  return (
    <SettingRow
      label={label}
      description="Summarizes each thread after every turn and writes titles, even when title updates are off."
      stacked
      control={
        <div className="w-full space-y-1.5">
          <ProviderModelPicker
            value={selected}
            onChange={(next) => onChange({ kind: "provider", ...next })}
            align="start"
            disabled={disabled}
            className="w-full"
            allowProviderChange
          />
          {directModel === null ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              This model runs in a hidden worker thread and takes several
              seconds longer per call.
            </p>
          ) : null}
          {/* Reserved for a future “Browse all AI Gateway models…” affordance. */}
        </div>
      }
    />
  );
}
