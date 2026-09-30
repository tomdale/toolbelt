import { Icon } from "@/components/ui/icon";
import type { CSSProperties } from "react";
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
}: {
  indicator: string;
  label: string | null;
}) {
  const role = statusRole(indicator);
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
  const a11y = label
    ? { role: "img", "aria-label": label, title: label }
    : { "aria-hidden": true };
  const props = {
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
