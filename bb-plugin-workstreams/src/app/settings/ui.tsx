import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover.tsx";

export function SettingRow({
  label,
  description,
  control,
  stacked = false,
  disabled = false,
  className,
}: {
  label: string;
  description?: string;
  control?: ReactNode;
  stacked?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center justify-between gap-5",
        stacked && "flex-col items-stretch gap-3",
        disabled && "opacity-50",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {control ? (
        <div className={cn("shrink-0", stacked && "w-full")}>{control}</div>
      ) : null}
    </div>
  );
}

export function SettingSwitch({
  checked,
  onChange,
  label,
  disabled = false,
  size = "md",
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed",
        size === "sm" ? "h-4 w-7" : "h-[18px] w-[32px]",
        checked ? "bg-primary" : "bg-muted-foreground/35",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none rounded-full bg-background shadow-sm transition-transform",
          size === "sm" ? "size-3" : "size-3.5",
          checked
            ? size === "sm"
              ? "translate-x-[12px]"
              : "translate-x-[15px]"
            : size === "sm"
              ? "translate-x-[1px]"
              : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  disabled = false,
  size = "md",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange(value: number): void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="group"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" && value < max) {
          event.preventDefault();
          onChange(value + 1);
        } else if (event.key === "ArrowDown" && value > min) {
          event.preventDefault();
          onChange(value - 1);
        }
      }}
      className={cn(
        "inline-flex items-center rounded-md border border-border bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        size === "sm" ? "h-7" : "h-8",
      )}
    >
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className={cn(
          "h-full rounded-l-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40",
          size === "sm" ? "w-6" : "w-7",
        )}
      >
        −
      </button>
      <output
        aria-label={label}
        className={cn(
          "text-center text-xs tabular-nums",
          size === "sm" ? "min-w-6" : "min-w-7",
        )}
      >
        {value}
      </output>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className={cn(
          "h-full rounded-r-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40",
          size === "sm" ? "w-6" : "w-7",
        )}
      >
        +
      </button>
    </div>
  );
}

export type PickerOption = {
  value: string;
  label: string;
  description?: string;
};

export function SettingsPicker({
  label,
  value,
  options,
  onChange,
  placeholder = "Choose…",
  disabled = false,
  className,
}: {
  label: string;
  value: string;
  options: readonly PickerOption[];
  onChange(value: string): void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const searchId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = options.find((option) => option.value === value);
  const filtered = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "flex h-8 min-w-0 max-w-full items-center justify-between gap-3 rounded-md border border-border bg-background px-2.5 text-left text-sm text-foreground hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
            className,
          )}
        >
          <span className="truncate">{current?.label ?? placeholder}</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="size-3.5 shrink-0 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m4.5 6 3.5 3.5L11.5 6" />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5">
        <label
          className="sr-only"
          htmlFor={searchId}
        >{`Search ${label}`}</label>
        <input
          id={searchId}
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={`Search ${label.toLowerCase()}…`}
          className="mb-1.5 h-8 w-full rounded border border-border bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          className="max-h-60 overflow-y-auto"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              const options = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "[role=option]",
                ),
              );
              if (!options.length) return;
              event.preventDefault();
              const currentIndex = options.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const delta = event.key === "ArrowDown" ? 1 : -1;
              options[
                (currentIndex + delta + options.length) % options.length
              ]?.focus();
            }
          }}
        >
          {filtered.length ? (
            filtered.map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <span className="min-w-0">
                  <span className="block truncate">{option.label}</span>
                  {option.description ? (
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                {option.value === value ? (
                  <span aria-hidden="true">✓</span>
                ) : null}
              </button>
            ))
          ) : (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No matches
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function CompactSettingRow({
  label,
  control,
  accessory,
}: {
  label: string;
  control: ReactNode;
  accessory?: ReactNode;
}) {
  return (
    <div className="grid min-h-8 grid-cols-[minmax(0,1fr)_auto_1.75rem] items-center gap-3">
      <p className="min-w-0 truncate text-sm text-foreground">{label}</p>
      <div className="flex min-w-24 justify-end">{accessory}</div>
      <div className="flex justify-end">{control}</div>
    </div>
  );
}

export function SectionRows({
  children,
  compact = false,
}: {
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card px-4",
        compact ? "py-2 [&>*+*]:mt-1" : "py-3.5 [&>*+*]:mt-5",
      )}
    >
      {children}
    </div>
  );
}

/**
 * A compact single choice among a few short options, drawn as one segmented
 * pill. Native radios give it arrow-key navigation and form semantics.
 */
export function SegmentedControl<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange(value: V): void;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex h-7 items-center rounded-md border border-border bg-background p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <label
            key={option.value}
            className={cn(
              "flex h-full min-w-16 cursor-pointer items-center justify-center rounded px-2 text-xs transition-colors has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
              selected
                ? "bg-accent font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}
