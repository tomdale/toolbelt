/**
 * The priority flag, drawn inline in the host's stroke icon style, since the
 * host icon set has no priority mark.
 */
export function PriorityIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M5 21V4.5M5 4.5h11.2c.6 0 1 .6.7 1.1L15 9.5l1.9 3.9c.3.5-.1 1.1-.7 1.1H5"
        fill="currentColor"
        fillOpacity={0.18}
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
