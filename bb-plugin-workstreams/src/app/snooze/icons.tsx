/**
 * Snooze glyphs, drawn inline in the host's icon style (Hugeicons' stroke
 * alarm clocks), since the host icon set has no snooze mark. The preset
 * list's grip and delete marks are drawn the same way.
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

/** Six dots: a handle that drags its row. */
export function GripIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      {[6, 12, 18].map((y) =>
        [9, 15].map((x) => (
          <circle
            key={`${x}-${y}`}
            cx={x}
            cy={y}
            r={1.25}
            fill="currentColor"
          />
        )),
      )}
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        {...stroke}
        d="M19.5 5.5L18.88 15.53C18.72 18.09 18.64 19.37 18.0 20.3C17.68 20.75 17.27 21.14 16.8 21.43C15.82 22 14.54 22 11.98 22C9.41 22 8.12 22 7.14 21.43C6.66 21.14 6.25 20.75 5.93 20.29C5.29 19.37 5.21 18.08 5.06 15.51L4.5 5.5"
      />
      <path {...stroke} d="M3 5.5H21" />
      <path
        {...stroke}
        d="M16.06 5.5L15.38 4.09C14.93 3.16 14.7 2.69 14.31 2.4C14.22 2.34 14.13 2.28 14.04 2.23C13.61 2 13.09 2 12.05 2C10.99 2 10.46 2 10.02 2.23C9.92 2.29 9.83 2.35 9.74 2.42C9.35 2.72 9.13 3.2 8.69 4.17L8.09 5.5"
      />
      <path {...stroke} d="M9.5 16.5V10.5" />
      <path {...stroke} d="M14.5 16.5V10.5" />
    </svg>
  );
}
