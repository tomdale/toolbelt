/**
 * The working indicator's settings: an animation shape, its color, and, for
 * shapes that draw a track, the track's color. Every choice is a native radio
 * button (arrow keys move within a group), and every preview is the live
 * spinner in the current colors. Each label is `relative` so its visually
 * hidden input stays inside it: an input positioned against an outer BB
 * container overflows it, and focusing the input then scrolls that container
 * and clips the settings page.
 */
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  COLOR_LABEL,
  HEX_COLOR,
  SHAPE_LABEL,
  SPINNER_COLORS,
  SPINNER_SHAPES,
  colorCss,
  hasTrack,
  trackCss,
  type SpinnerColor,
  type SpinnerStyle,
  type SpinnerTrack,
} from "../../domain/spinner.ts";
import { WorkingMark } from "../sidebar/StatusMark.tsx";
import { useSetSpinner, useSpinner } from "../spinner.ts";

export function SpinnerSettings() {
  const style = useSpinner();
  const [error, setError] = useState<string | null>(null);
  const onError = useCallback(
    (cause: unknown) =>
      setError(
        cause instanceof Error ? cause.message : "Couldn't save the choice.",
      ),
    [],
  );
  const save = useSetSpinner(onError);
  const trackRef = useRef<HTMLFieldSetElement>(null);
  // Set when a pick makes the track group appear, so it can be revealed.
  const revealTrack = useRef(false);
  const change = (patch: Partial<SpinnerStyle>) => {
    setError(null);
    if (patch.shape && hasTrack(patch.shape) && !hasTrack(style.shape))
      revealTrack.current = true;
    save(patch);
  };
  const showTrack = hasTrack(style.shape);
  useLayoutEffect(() => {
    if (!showTrack || !revealTrack.current || !trackRef.current) return;
    revealTrack.current = false;
    revealInScroller(trackRef.current);
  }, [showTrack]);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <ShapeGrid style={style} onPick={(shape) => change({ shape })} />
      <Swatches
        value={style.primary}
        onPick={(primary) => change({ primary })}
        customLabel="Custom color"
      />
      {showTrack ? (
        <fieldset ref={trackRef} className="min-w-0">
          <legend className="sr-only">Track color</legend>
          <Swatches
            value={style.secondary}
            onPick={(secondary) => change({ secondary })}
            customLabel="Custom track color"
            extra={[
              {
                value: "auto",
                label: "Faded color",
                fill: trackCss({ ...style, secondary: "auto" }),
              },
              { value: "none", label: "No track", fill: null },
            ]}
          />
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Scrolls the nearest scrolling ancestor just enough to show `element`.
 * `scrollIntoView` isn't used because it also scrolls BB's `overflow-hidden`
 * layout containers, shifting the whole settings page.
 */
function revealInScroller(element: HTMLElement): void {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    const box = node.getBoundingClientRect();
    const target = element.getBoundingClientRect();
    const margin = 16;
    if (target.bottom + margin > box.bottom)
      node.scrollTop += Math.min(
        target.bottom + margin - box.bottom,
        target.top - box.top - margin,
      );
    return;
  }
}

function ShapeGrid({
  style,
  onPick,
}: {
  style: SpinnerStyle;
  onPick: (shape: SpinnerStyle["shape"]) => void;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label="Working indicator style"
      className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2"
    >
      {SPINNER_SHAPES.map((shape) => {
        const { name: label, note } = SHAPE_LABEL[shape];
        const checked = style.shape === shape;
        return (
          <label
            key={shape}
            title={note}
            className={cn(
              "relative flex min-w-0 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border px-2 py-2.5 text-xs transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
              checked
                ? "border-primary bg-accent text-foreground ring-1 ring-primary/40"
                : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <input
              type="radio"
              name={name}
              value={shape}
              checked={checked}
              onChange={() => onPick(shape)}
              className="sr-only"
            />
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center"
            >
              <span className="inline-flex scale-125">
                <WorkingMark spinner={{ ...style, shape }} />
              </span>
            </span>
            <span className={checked ? "font-medium" : undefined}>{label}</span>
          </label>
        );
      })}
    </div>
  );
}

type SwatchOption = {
  value: SpinnerTrack;
  label: string;
  /** CSS fill; null draws the "none" swatch. */
  fill: string | null;
};

/**
 * Named colors as round swatches, plus a custom color. The custom swatch
 * opens the system color picker and shows the chosen color once picked.
 */
function Swatches<T extends SpinnerTrack>({
  value,
  onPick,
  customLabel,
  extra = [],
}: {
  value: T;
  onPick: (value: T) => void;
  customLabel: string;
  extra?: readonly SwatchOption[];
}) {
  const name = useId();
  const options: SwatchOption[] = [
    ...extra,
    ...SPINNER_COLORS.map((color) => ({
      value: color,
      label: COLOR_LABEL[color],
      fill: colorCss(color),
    })),
  ];
  const custom = typeof value === "string" && HEX_COLOR.test(value);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.map((option) => (
        <label
          key={option.value}
          title={option.label}
          className="relative cursor-pointer rounded-full has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onPick(option.value as T)}
            aria-label={option.label}
            className="sr-only"
          />
          <Swatch fill={option.fill} checked={value === option.value} />
        </label>
      ))}
      <label
        title={customLabel}
        className="relative cursor-pointer rounded-full has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
      >
        <input
          type="color"
          aria-label={customLabel}
          value={custom ? value : "#7c7cff"}
          onChange={(event) => onPick(event.target.value as T)}
          className="sr-only"
        />
        <Swatch
          fill={
            custom
              ? (value as SpinnerColor)
              : "conic-gradient(from 0deg, #f55, #fb5, #5d5, #5bf, #a6f, #f55)"
          }
          checked={custom}
        />
      </label>
    </div>
  );
}

function Swatch({ fill, checked }: { fill: string | null; checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 items-center justify-center rounded-full border-2",
        checked
          ? "border-primary ring-2 ring-primary/40"
          : "border-transparent",
      )}
    >
      <span
        className="relative block size-5 overflow-hidden rounded-full border border-border"
        style={fill ? { background: fill } : undefined}
      >
        {fill ? null : (
          // "No track": an empty circle struck through.
          <span className="absolute left-1/2 top-[-2px] h-6 w-px -translate-x-1/2 rotate-45 bg-muted-foreground" />
        )}
      </span>
    </span>
  );
}
