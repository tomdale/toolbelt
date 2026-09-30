/**
 * The working indicator's style: an animation shape drawn in one or two
 * colors the user picks. Shapes are monochrome; the primary color draws the
 * moving part, and shapes with a track (see {@link hasTrack}) draw it in the
 * secondary color.
 */

export const SPINNER_SHAPES = [
  "spokes",
  "bold-spokes",
  "arc",
  "orbit",
  "ring",
  "braille",
  "dots",
] as const;
export type SpinnerShape = (typeof SPINNER_SHAPES)[number];

/** Named colors, drawn from the theme so they read in light and dark. */
export const SPINNER_COLORS = [
  "subtle",
  "gray",
  "text",
  "green",
  "blue",
  "amber",
  "purple",
] as const;
export type SpinnerColorName = (typeof SPINNER_COLORS)[number];
/** A named color or a custom `#rrggbb`. */
export type SpinnerColor = SpinnerColorName | `#${string}`;
/** `auto` is the primary color, faded; `none` draws no track. */
export type SpinnerTrack = SpinnerColor | "auto" | "none";

export type SpinnerStyle = {
  readonly shape: SpinnerShape;
  readonly primary: SpinnerColor;
  readonly secondary: SpinnerTrack;
};

/** BB's own sidebar spinner. */
export const DEFAULT_SPINNER: SpinnerStyle = {
  shape: "spokes",
  primary: "subtle",
  secondary: "auto",
};

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const SHAPE_LABEL: Record<SpinnerShape, { name: string; note: string }> =
  {
    spokes: { name: "Spokes", note: "BB's own spinner" },
    "bold-spokes": { name: "Sunburst", note: "Heavier spokes" },
    arc: { name: "Arc", note: "A thin arc on a track" },
    orbit: { name: "Orbit", note: "A dot circling a ring" },
    ring: { name: "Ring", note: "A thicker, longer arc" },
    braille: { name: "Braille", note: "Terminal style" },
    dots: { name: "Dots", note: "A typing wave" },
  };

export const COLOR_LABEL: Record<SpinnerColorName, string> = {
  subtle: "Subtle gray",
  gray: "Gray",
  text: "Text color",
  green: "Green",
  blue: "Blue",
  amber: "Amber",
  purple: "Purple",
};

/** Whether a shape draws a track in the secondary color. */
export const hasTrack = (shape: SpinnerShape): boolean =>
  shape === "arc" || shape === "orbit" || shape === "ring";

const COLOR_CSS: Record<SpinnerColorName, string> = {
  subtle: "color-mix(in oklab, var(--muted-foreground) 50%, transparent)",
  gray: "var(--muted-foreground)",
  text: "var(--foreground, #ededed)",
  green: "var(--success-foreground, #46a758)",
  blue: "var(--primary, #3e63dd)",
  amber: "var(--warning-text, #e0a84f)",
  purple: "oklch(65% 0.2 300)",
};

export const colorCss = (color: SpinnerColor): string =>
  isColorName(color) ? COLOR_CSS[color] : color;

/** The track's CSS color: `auto` fades the primary color. */
export function trackCss(style: SpinnerStyle): string {
  if (style.secondary === "none") return "transparent";
  if (style.secondary === "auto")
    return `color-mix(in oklab, ${colorCss(style.primary)} 22%, transparent)`;
  return colorCss(style.secondary);
}

const isColorName = (value: unknown): value is SpinnerColorName =>
  SPINNER_COLORS.includes(value as SpinnerColorName);

const isColor = (value: unknown): value is SpinnerColor =>
  isColorName(value) || (typeof value === "string" && HEX_COLOR.test(value));

/** A stored or pushed value as a style; unknown parts fall back to BB's own. */
export function parseSpinner(value: unknown): SpinnerStyle {
  if (typeof value === "string") {
    try {
      return parseSpinner(JSON.parse(value));
    } catch {
      return DEFAULT_SPINNER;
    }
  }
  if (!value || typeof value !== "object") return DEFAULT_SPINNER;
  const raw = value as Record<string, unknown>;
  return {
    shape: SPINNER_SHAPES.includes(raw.shape as SpinnerShape)
      ? (raw.shape as SpinnerShape)
      : DEFAULT_SPINNER.shape,
    primary: isColor(raw.primary) ? raw.primary : DEFAULT_SPINNER.primary,
    secondary:
      raw.secondary === "auto" ||
      raw.secondary === "none" ||
      isColor(raw.secondary)
        ? (raw.secondary as SpinnerTrack)
        : DEFAULT_SPINNER.secondary,
  };
}

export const sameSpinner = (a: SpinnerStyle, b: SpinnerStyle): boolean =>
  a.shape === b.shape && a.primary === b.primary && a.secondary === b.secondary;
