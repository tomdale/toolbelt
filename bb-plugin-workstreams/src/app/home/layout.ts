/**
 * Where the phone Home section sits in BB's new-thread view, and what it does
 * about BB's own Recent list.
 *
 * BB offers plugins a `homepageSection` slot, rendered after its flat Recent
 * list inside a scroll viewport whose top edge BB places a few rows above the
 * composer. There is no slot to replace that list or to resize the viewport,
 * so the section finds out where it was mounted and, on BB's compact home,
 * asks the stylesheet (home.css) to stand in for both. Everything BB-specific
 * lives in this file and in home.css:
 *
 * - `takeover`: mounted inside BB's compact home scroll viewport. The section
 *   replaces BB's Recent list and uses the viewport's full height.
 * - `inline`: a narrow window where BB's compact viewport wasn't found (its
 *   markup changed, or its empty welcome is showing). The section renders
 *   below BB's Recent list and leaves BB alone.
 * - `hidden`: wide windows, the preference being off, or nothing to show. The
 *   section renders nothing and hides its heading.
 */

/** BB's compact home scroll viewport (`RootComposeCompactHome`). */
export const COMPACT_HOME_VIEWPORT =
  '[data-testid="root-compose-compact-scroll-viewport"]';

export type Placement = "compact" | "narrow" | "wide";
export type HomeMode = "takeover" | "inline" | "hidden";

/** Where `probe`, an element inside the section, was mounted. */
export function detectPlacement(
  probe: Element | null,
  narrowViewport: boolean,
): Placement {
  if (probe?.closest(COMPACT_HOME_VIEWPORT)) return "compact";
  return narrowViewport ? "narrow" : "wide";
}

/**
 * How the section presents itself. `status` is the thread list's load state:
 * while it loads the takeover shows a placeholder so BB's list doesn't flash,
 * and on error the section steps aside so BB's list remains.
 */
export function homeMode(input: {
  placement: Placement;
  enabled: boolean;
  status: "loading" | "ready" | "error";
  hasContent: boolean;
}): HomeMode {
  if (!input.enabled || input.placement === "wide") return "hidden";
  if (input.status === "error") return "inline";
  if (input.status === "ready" && !input.hasContent) return "hidden";
  if (input.status === "loading" && input.placement === "narrow")
    return "hidden";
  return input.placement === "compact" ? "takeover" : "inline";
}
