import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type SelectOption<V extends string> = {
  readonly value: V;
  readonly label: string;
};

/**
 * Radix Select reserves the empty string for "nothing chosen", but the
 * plugin's filters use it for "all"; options carry this in its place.
 */
const EMPTY = "\u0000empty";

/**
 * BB's select control (the vendored `@bb/select`), for a pick from a short
 * fixed list: its trigger and popup match BB's own, which a native
 * `<select>` cannot. With a `placeholder` and the value `""`, nothing is
 * chosen yet and the trigger shows the placeholder.
 */
export function SelectField<V extends string>({
  label,
  value,
  options,
  onChange,
  placeholder,
  autoFocus,
  className,
}: {
  /** The accessible name; the trigger shows only the chosen option. */
  label: string;
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Sizes the trigger; it defaults to BB's full-width, 36px control. */
  className?: string;
}) {
  const encode = (v: string) => (v === "" ? EMPTY : v);
  return (
    <Select
      value={value === "" && placeholder ? "" : encode(value)}
      onValueChange={(next) => onChange((next === EMPTY ? "" : next) as V)}
    >
      <SelectTrigger
        aria-label={label}
        autoFocus={autoFocus}
        className={cn("gap-2", className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={encode(option.value)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
