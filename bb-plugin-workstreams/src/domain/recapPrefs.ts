/**
 * How recaps behave, chosen in the Recap settings section. Stored in plugin
 * storage rather than declarative settings because the section draws its own
 * controls (layout previews, a live automatic toggle) and saves each change
 * immediately.
 */
import { z } from "zod";

export const RECAP_LAYOUTS = ["detailed", "compact", "minimal"] as const;
export type RecapLayout = (typeof RECAP_LAYOUTS)[number];

export const RECAP_LAYOUT_OPTIONS: readonly {
  value: RecapLayout;
  label: string;
  description: string;
}[] = [
  {
    value: "detailed",
    label: "Detailed",
    description: "Goal, latest results, and the Open and Done list.",
  },
  {
    value: "compact",
    label: "Compact",
    description: "Goal and latest results.",
  },
  { value: "minimal", label: "Minimal", description: "Latest results only." },
];

export const QUIET_SECONDS = { min: 5, max: 600, fallback: 30 } as const;
export const MIN_TURNS = { min: 1, max: 20, fallback: 3 } as const;

const bounded = (range: { min: number; max: number; fallback: number }) =>
  z
    .number()
    .int()
    .catch(range.fallback)
    .transform((value) => Math.min(range.max, Math.max(range.min, value)));

export const recapPrefsSchema = z.object({
  /** Recap each thread after it has been quiet; off shows Generate Recap. */
  automatic: z.boolean().catch(true),
  layout: z.enum(RECAP_LAYOUTS).catch("detailed"),
  /** Seconds a thread must stay idle before an automatic recap. */
  quietSeconds: bounded(QUIET_SECONDS),
  /** User turns a thread needs before automatic recaps start. */
  minTurns: bounded(MIN_TURNS),
});
export type RecapPrefs = z.infer<typeof recapPrefsSchema>;

export function parseRecapPrefs(raw: unknown): RecapPrefs {
  const value = raw && typeof raw === "object" ? raw : {};
  return recapPrefsSchema.parse({
    automatic: true,
    layout: "detailed",
    quietSeconds: QUIET_SECONDS.fallback,
    minTurns: MIN_TURNS.fallback,
    ...value,
  });
}
