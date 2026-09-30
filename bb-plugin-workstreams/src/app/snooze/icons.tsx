/**
 * Snooze glyphs, drawn inline in the host's icon style (Hugeicons' stroke
 * alarm clocks), since the host icon set has no snooze mark.
 */
type IconProps = { className?: string };

const stroke = {
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  fill: "none",
} as const;

export function SnoozeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        {...stroke}
        d="M20.5 12.5C20.5 17.1944 16.6944 21 12 21C7.30558 21 3.5 17.1944 3.5 12.5C3.5 7.80558 7.30558 4 12 4C16.6944 4 20.5 7.80558 20.5 12.5Z"
      />
      <path {...stroke} d="M5.88 18.7031L3.5 21.0031" />
      <path {...stroke} d="M18.14 18.668L20.5 20.998" />
      <path {...stroke} d="M5 3L2 6" />
      <path {...stroke} d="M22 6L19 3" />
      <path {...stroke} d="M12 8V12.5L14 14.5" />
    </svg>
  );
}

export function WakeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        {...stroke}
        d="M9.40379 4.40379C10.2222 4.14157 11.0946 4 12 4C16.6944 4 20.5 7.80558 20.5 12.5C20.5 13.4054 20.3584 14.2778 20.0962 15.0962M6.24476 6.24476C4.5573 7.79814 3.5 10.0256 3.5 12.5C3.5 17.1944 7.30558 21 12 21C14.4744 21 16.7019 19.9427 18.2552 18.2552"
      />
      <path {...stroke} d="M5.88 18.7031L3.5 21.0031" />
      <path {...stroke} d="M2 2L22 22" />
      <path {...stroke} d="M4 4L2 6" />
      <path {...stroke} d="M22 6L19 3" />
    </svg>
  );
}
