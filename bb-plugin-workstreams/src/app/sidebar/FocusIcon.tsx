/**
 * The focus mark, a viewfinder drawn inline in the host's stroke icon style,
 * since the host icon set has none.
 */
export function FocusIcon({
  className,
  filled = false,
}: {
  className?: string;
  /** Solid, for a workstream that is focused; else a light tint. */
  filled?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
      <circle
        cx="12"
        cy="12"
        r="3.5"
        fill="currentColor"
        fillOpacity={filled ? 0.9 : 0.18}
      />
    </svg>
  );
}
