import { STATUS_LABEL, statusRole } from "../../domain/presentation.ts";

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
