/**
 * How recaps behave, chosen in the Recap settings section. Stored in plugin
 * storage rather than declarative settings because the section draws its own
 * controls (layout previews) and saves each change immediately, and because
 * the synchronous `configure` callback reads them.
 */
import { z } from "zod";

export const RECAP_LAYOUTS = ["full", "minimal"] as const;
export type RecapLayout = (typeof RECAP_LAYOUTS)[number];

export const RECAP_LAYOUT_OPTIONS: readonly {
  value: RecapLayout;
  label: string;
  description: string;
}[] = [
  {
    value: "full",
    label: "Full",
    description: "Goal, latest results, review, and deliverables.",
  },
  {
    value: "minimal",
    label: "Minimal",
    description: "Everything except the goal heading.",
  },
];

export const CORRECTIONS = { min: 0, max: 10, fallback: 3 } as const;

export const recapPrefsSchema = z.object({
  /** Agents get the recap tool and are asked for a recap after each turn. */
  required: z.boolean().catch(true),
  /** Automatic reminders per turn when an agent ends it without a recap. */
  corrections: z
    .number()
    .int()
    .catch(CORRECTIONS.fallback)
    .transform((value) =>
      Math.min(CORRECTIONS.max, Math.max(CORRECTIONS.min, value)),
    ),
  layout: z.enum(RECAP_LAYOUTS).catch("full"),
});
export type RecapPrefs = z.infer<typeof recapPrefsSchema>;

export function parseRecapPrefs(raw: unknown): RecapPrefs {
  const value = raw && typeof raw === "object" ? raw : {};
  return recapPrefsSchema.parse({
    required: true,
    corrections: CORRECTIONS.fallback,
    layout: "full",
    ...value,
  });
}
