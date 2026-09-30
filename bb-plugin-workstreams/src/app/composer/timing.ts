/**
 * When a draft is routed while the user types. A short draft is often a
 * thought in progress, so it waits for typing to pause; once it is long
 * enough to say what the work is, it is routed on a short debounce so the
 * preview keeps up. Any keystroke also cancels the routing call in flight.
 */
export const SHORT_DRAFT_CHARS = 20;
export const SHORT_PAUSE_MS = 900;
export const DEBOUNCE_MS = 250;

/** How long after the last change to route `text`. */
export function routeDelay(text: string): number {
  return text.trim().length < SHORT_DRAFT_CHARS ? SHORT_PAUSE_MS : DEBOUNCE_MS;
}
