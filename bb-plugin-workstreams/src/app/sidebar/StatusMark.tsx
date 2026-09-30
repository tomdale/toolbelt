import { Icon } from "@/components/ui/icon";
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { STATUS_LABEL, statusRole } from "../../domain/presentation.ts";
import { colorCss, trackCss, type SpinnerStyle } from "../../domain/spinner.ts";
import { useSpinner } from "../spinner.ts";

/**
 * BB's resolved thread status, drawn as a small mark. BB ships no status
 * component, so the list owns the glyphs; unknown kinds draw nothing.
 */
export function StatusMark({
  indicator,
  label,
  hasPendingInteraction = false,
  isUnread = false,
}: {
  indicator: string;
  label: string | null;
  /** BB sometimes exposes these facts separately from its indicator kind. */
  hasPendingInteraction?: boolean;
  isUnread?: boolean;
}) {
  const role =
    statusRole(indicator) ??
    (hasPendingInteraction ? "waiting" : isUnread ? "unread" : null);
  if (!role) return <span className="ws-mark" aria-hidden="true" />;
  const text = label ?? STATUS_LABEL[role];
  if (role === "working") return <WorkingMark label={text} />;
  return (
    <span
      className={`ws-mark ws-mark-${role}`}
      role="img"
      aria-label={text}
      title={text}
    >
      {role === "waiting"
        ? "?"
        : role === "error"
          ? "!"
          : role === "draft"
            ? "✎"
            : null}
    </span>
  );
}

/**
 * Put every CSS animation for a shape on the document timeline's zero point.
 * CSS animations otherwise use the element's insertion time as their start,
 * which makes rows mounted later visibly drift out of phase. The browser owns
 * all frame scheduling; this only adjusts Web Animations API metadata once.
 */
export function synchronizeSpinnerAnimations(element: HTMLElement): void {
  if (typeof element.getAnimations !== "function") return;
  const animations = element.getAnimations({ subtree: true });
  for (const animation of animations) {
    // The shape's CSS animation is the only animation in this subtree. Keeping
    // this assignment in one place also includes animations on pseudo-elements.
    animation.startTime = 0;
  }
}

/**
 * The working indicator, in the style chosen in settings unless `spinner`
 * gives one (the settings previews). Shapes read their colors from
 * `--ws-spin-primary` and `--ws-spin-track`. Unlabeled marks are decorative:
 * the caller announces the work in text.
 */
export function WorkingMark({
  label,
  spinner: shown,
}: {
  label?: string;
  spinner?: SpinnerStyle;
}) {
  const chosen = useSpinner();
  const spinner = shown ?? chosen;
  const markRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (markRef.current) synchronizeSpinnerAnimations(markRef.current);
  }, [spinner.shape]);
  const a11y = label
    ? { role: "img", "aria-label": label, title: label }
    : { "aria-hidden": true };
  const props = {
    ref: markRef,
    className: `ws-mark ws-spin ws-spin-${spinner.shape}`,
    style: {
      "--ws-spin-primary": colorCss(spinner.primary),
      "--ws-spin-track": trackCss(spinner),
    } as CSSProperties,
    ...a11y,
  };
  if (spinner.shape === "spokes" || spinner.shape === "bold-spokes")
    return (
      <span {...props}>
        <Icon name="Loading" aria-hidden className="ws-spin-icon" />
      </span>
    );
  if (spinner.shape === "dots")
    return (
      <span {...props}>
        <i />
        <i />
        <i />
      </span>
    );
  return <span {...props} />;
}
