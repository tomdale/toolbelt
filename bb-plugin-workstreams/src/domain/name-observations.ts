import { z } from "zod";

const name = z.string().trim().min(1).max(100);

/** Product and feature names a model reported for one analysis run. */
export type NameObservations = {
  products: string[];
  features: { name: string; product: string | null }[];
};

const NAME_MAX = 100;
const LIST_MAX = 40;

/**
 * One reported name, trimmed. An empty, over-long, or non-text name is
 * dropped rather than clipped: a clipped name is a different name.
 */
function reportedName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= NAME_MAX ? trimmed : null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Reads the `names` a model returned, keeping every entry that is usable.
 * Observations are advisory, so a malformed entry costs only itself: one
 * feature written as a bare string must not discard the products and other
 * features reported beside it. A feature may be a bare name, or an object
 * whose missing or unusable `product` reads as null.
 */
export function parseNameObservations(raw: unknown): NameObservations {
  const names = record(raw);
  if (!names) return emptyObservations();
  return {
    products: list(names.products)
      .map(reportedName)
      .filter((product): product is string => product !== null)
      .slice(0, LIST_MAX),
    features: list(names.features)
      .flatMap((feature) => {
        const detail = record(feature);
        const featureName = reportedName(detail ? detail.name : feature);
        if (featureName === null) return [];
        return [
          {
            name: featureName,
            product: detail ? reportedName(detail.product) : null,
          },
        ];
      })
      .slice(0, LIST_MAX),
  };
}

const seen = z.object({
  name,
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  runs: z.number().int().positive(),
});
export const observedNamesSchema = z.object({
  products: z.array(seen),
  features: z.array(seen.extend({ product: name.nullable() })),
});
export type ObservedNames = z.infer<typeof observedNamesSchema>;

export const emptyObservations = (): NameObservations => ({
  products: [],
  features: [],
});
export const emptyObservedNames = (): ObservedNames => ({
  products: [],
  features: [],
});

export function aggregateNames(
  runs: readonly { at: number; names: NameObservations }[],
): ObservedNames {
  const products = new Map<string, ObservedNames["products"][number]>();
  const features = new Map<string, ObservedNames["features"][number]>();
  const key = (value: string) =>
    value.replace(/\s+/g, " ").trim().toLowerCase();
  for (const run of runs) {
    const productNames = new Map<string, string>();
    for (const product of [
      ...run.names.products,
      ...run.names.features.flatMap((feature) =>
        feature.product ? [feature.product] : [],
      ),
    ])
      productNames.set(key(product), product);
    for (const [id, product] of productNames) {
      const existing = products.get(id);
      products.set(id, {
        name: existing?.name ?? product,
        firstSeenAt: Math.min(existing?.firstSeenAt ?? run.at, run.at),
        lastSeenAt: Math.max(existing?.lastSeenAt ?? run.at, run.at),
        runs: (existing?.runs ?? 0) + 1,
      });
    }
    const featureNames = new Map<
      string,
      NameObservations["features"][number]
    >();
    for (const feature of run.names.features)
      featureNames.set(
        JSON.stringify([
          key(feature.name),
          feature.product ? key(feature.product) : null,
        ]),
        feature,
      );
    for (const [id, feature] of featureNames) {
      const existing = features.get(id);
      features.set(id, {
        name: existing?.name ?? feature.name,
        product: existing?.product ?? feature.product,
        firstSeenAt: Math.min(existing?.firstSeenAt ?? run.at, run.at),
        lastSeenAt: Math.max(existing?.lastSeenAt ?? run.at, run.at),
        runs: (existing?.runs ?? 0) + 1,
      });
    }
  }
  return {
    products: [...products.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    features: [...features.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        (a.product ?? "").localeCompare(b.product ?? ""),
    ),
  };
}
