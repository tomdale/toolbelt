/**
 * Geometry of the sticky goal heading (StickyGoalHeader), kept pure so the
 * sizes it reserves and draws can be tested without a browser.
 *
 * Every size is a multiple of the timeline's body font size, so the heading
 * scales with the text around it. Expanded, the heading is the most prominent
 * text on the page: the workstream line, a large title, and the current
 * subtask. Scrolled away from the newest message it collapses into a compact
 * workstream-over-goal block, in the title bar when there is room and pinned
 * at the top of the timeline when there is not.
 */

export const TITLE_SIZE = 1.5;
export const SUBTITLE_SIZE = 0.92;
export const TITLE_LINE = 4 / 3;
export const SUBTITLE_LINE = 1.4;
export const PAD_TOP = 0.85;
export const PAD_BOTTOM = 0.65;
/** Workstream line plus the gap before the title, when there is a workstream. */
export const EYEBROW_BLOCK = 1.25;
/** In the title bar the title is set at this multiple of body size. */
export const TITLE_BAR_TITLE_SIZE = 0.95;
/** Padding above and below the heading when it stays pinned in the timeline. */
export const PINNED_PAD = 0.3;

/**
 * BB's own phone condition: a viewport under its `md` breakpoint driven by a
 * coarse pointer. It is the condition under which BB bumps its type tokens
 * (`--text-xs` and up) and sizes its controls for touch, so the heading
 * follows the same rule.
 */
export const PHONE_QUERY = "(max-width: 767px) and (pointer: coarse)";

/**
 * The workstream line above the title. On a desktop-class layout it is small
 * and shrinks further in the title bar, where space is tight. On a phone it
 * is one fixed size in every state, and `--text-xs` is the size BB sets its
 * secondary text in there, so it keeps one reading size and one reserved
 * height whether the heading is expanded or compact.
 */
export type Eyebrow = {
  /** Font size in px. */
  readonly size: number;
  /** Scale applied while the heading is compact. */
  readonly compactScale: number;
  /** Room reserved above the title when expanded, in px. */
  readonly expandedBlock: number;
  /** Room reserved above the title when compact, in px. */
  readonly compactBlock: number;
};

const DESKTOP_EYEBROW_SIZE = 0.8;
const DESKTOP_COMPACT_SCALE = 0.82;
const DESKTOP_COMPACT_BLOCK_PX = 10;
/** 14px at the 16px body size phones use: BB's `text-xs` there. */
const PHONE_EYEBROW_SIZE = 0.875;

export function eyebrowMetrics(base: number, phone: boolean): Eyebrow {
  const expandedBlock = base * EYEBROW_BLOCK;
  return phone
    ? {
        size: base * PHONE_EYEBROW_SIZE,
        compactScale: 1,
        expandedBlock,
        compactBlock: expandedBlock,
      }
    : {
        size: base * DESKTOP_EYEBROW_SIZE,
        compactScale: DESKTOP_COMPACT_SCALE,
        expandedBlock,
        compactBlock: DESKTOP_COMPACT_BLOCK_PX,
      };
}

/** Expanded heading height in px for a body font size. */
export function headingHeight(
  base: number,
  hasEyebrow: boolean,
  titleLines: number,
): number {
  return Math.round(
    base *
      (PAD_TOP +
        (hasEyebrow ? EYEBROW_BLOCK : 0) +
        TITLE_SIZE * TITLE_LINE * titleLines +
        SUBTITLE_SIZE * SUBTITLE_LINE +
        PAD_BOTTOM),
  );
}

/** The collapsed text block (workstream over title) in px. */
export function compactBlock(base: number, eyebrow: Eyebrow | null): number {
  return (
    (eyebrow ? eyebrow.compactBlock : 0) +
    base * TITLE_BAR_TITLE_SIZE * TITLE_LINE
  );
}

/** Plate height when the collapsed heading stays pinned in the timeline. */
export function pinnedHeight(base: number, eyebrow: Eyebrow | null): number {
  return Math.round(compactBlock(base, eyebrow) + base * PINNED_PAD * 2);
}
