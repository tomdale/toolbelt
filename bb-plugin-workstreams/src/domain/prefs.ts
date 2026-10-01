/**
 * Workstreams' general preferences, grouped by the feature each one belongs
 * to. Stored in plugin storage rather than BB's declarative settings, because
 * the settings page draws its own controls (BB's model picker, previews,
 * machine picker) and saves each change immediately.
 *
 * Recap, snooze, and working-indicator preferences keep their own stores.
 */
import { z } from "zod";

/**
 * A model Workstreams calls. `gateway` names an AI Gateway model directly
 * (`google/gemini-3.1-flash-lite`) and always runs as one direct completion.
 * `provider` is a BB provider/model pick from BB's model picker: a Pi
 * `vercel-ai-gateway/<model>` pick also runs as a direct completion, and any
 * other pick runs in a hidden BB worker thread, which is several seconds
 * slower per call.
 */
export const modelChoiceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("gateway"),
    model: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal("provider"),
    providerId: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    reasoningLevel: z.string().min(1).max(50),
    serviceTier: z.string().min(1).max(50).optional(),
  }),
]);
export type ModelChoice = z.infer<typeof modelChoiceSchema>;

/** The Pi model-id prefix whose picks run as direct gateway completions. */
export const PI_GATEWAY_PREFIX = "vercel-ai-gateway/";

/**
 * The AI Gateway model a choice runs directly, or null when it needs a BB
 * worker thread.
 */
export function gatewayModel(choice: ModelChoice): string | null {
  if (choice.kind === "gateway") return choice.model;
  if (choice.providerId === "pi" && choice.model.startsWith(PI_GATEWAY_PREFIX))
    return choice.model.slice(PI_GATEWAY_PREFIX.length);
  return null;
}

/** Eval-tested defaults (see SPEC.md and eval/). */
export const DEFAULT_MODELS = {
  analysis: { kind: "gateway", model: "google/gemini-3.1-flash-lite" },
  suggestions: { kind: "gateway", model: "google/gemini-3.1-flash-lite" },
  organize: { kind: "gateway", model: "openai/gpt-6-sol-fast" },
} as const satisfies Record<string, ModelChoice>;

export const RECENT_LIMIT = { min: 1, max: 20, fallback: 5 } as const;

const recentLimit = z
  .number()
  .int()
  .transform((n) => Math.min(RECENT_LIMIT.max, Math.max(RECENT_LIMIT.min, n)));

/**
 * Each feature group's fields, strict. Patches validate against these; the
 * stored shape (`prefsSchema`) falls back to defaults field by field, so one
 * bad stored value never resets its neighbors.
 */
const GROUPS = {
  sidebar: {
    /** The Up Next section: threads waiting on the user. */
    showForYou: [z.boolean(), true],
    /** The Recent band: the most recently active threads. */
    showRecent: [z.boolean(), true],
    /** How many threads the Recent band shows. */
    recentLimit: [recentLimit, RECENT_LIMIT.fallback],
  },
  threads: {
    /** Title untitled threads and retitle them as work moves on. */
    autoTitle: [z.boolean(), true],
    /** Summarizes each thread after every turn, and writes titles. */
    analysisModel: [modelChoiceSchema, DEFAULT_MODELS.analysis],
    /** A link to the parent thread in child threads' headers. */
    showParentLink: [z.boolean(), false],
  },
  newWork: {
    /** Where work with no code target starts; "" is a personal workspace. */
    homeProjectId: [z.string(), ""],
    /** Suggest a home for a new-thread draft while the user types. */
    suggestions: [z.boolean(), true],
    suggestionsModel: [modelChoiceSchema, DEFAULT_MODELS.suggestions],
  },
  organize: {
    /** Proposes the workstream map and files threads when you organize. */
    model: [modelChoiceSchema, DEFAULT_MODELS.organize],
  },
  advanced: {
    /** The machine whose Pi key runs gateway calls; "" picks the only one. */
    hostId: [z.string(), ""],
    /** Record every model call and show inspect buttons. */
    debug: [z.boolean(), false],
  },
} as const satisfies Record<
  string,
  Record<string, readonly [z.ZodType, unknown]>
>;

type Groups = typeof GROUPS;
type Fields<G extends keyof Groups> = {
  -readonly [K in keyof Groups[G]]: Groups[G][K] extends readonly [
    infer S extends z.ZodType,
    unknown,
  ]
    ? z.output<S>
    : never;
};
export type Prefs = { [G in keyof Groups]: Fields<G> };

/** One feature group's fields to change; omitted groups and fields stay. */
export type PrefsPatch = { [G in keyof Prefs]?: Partial<Prefs[G]> };

function group<G extends keyof Groups>(name: G, strict: boolean) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, [schema, fallback]] of Object.entries(GROUPS[name]) as [
    string,
    readonly [z.ZodType, unknown],
  ][])
    shape[key] = strict ? schema.optional() : schema.catch(fallback);
  return strict ? z.object(shape).strict().optional() : z.object(shape);
}

const groupNames = Object.keys(GROUPS) as (keyof Groups)[];

export const prefsSchema = z.object(
  Object.fromEntries(groupNames.map((g) => [g, group(g, false)])),
) as unknown as z.ZodType<Prefs>;

export const prefsPatchSchema = z
  .object(Object.fromEntries(groupNames.map((g) => [g, group(g, true)])))
  .strict() as unknown as z.ZodType<PrefsPatch>;

export function parsePrefs(raw: unknown): Prefs {
  const value = raw && typeof raw === "object" ? raw : {};
  const groups = value as Record<string, unknown>;
  return prefsSchema.parse(
    Object.fromEntries(
      groupNames.map((g) => {
        const v = groups[g];
        return [g, v && typeof v === "object" ? v : {}];
      }),
    ),
  );
}

/** Applies `patch` group by group, then re-parses so values stay in range. */
export function mergePrefs(base: Prefs, patch: PrefsPatch): Prefs {
  return parsePrefs(
    Object.fromEntries(groupNames.map((g) => [g, { ...base[g], ...patch[g] }])),
  );
}
