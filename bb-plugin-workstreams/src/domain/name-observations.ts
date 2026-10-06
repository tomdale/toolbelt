import { z } from "zod";

const name = z.string().trim().min(1).max(100);

export const nameObservationsSchema = z.object({
  products: z.array(name).max(40),
  features: z.array(z.object({ name, product: name.nullable() })).max(40),
});
export type NameObservations = z.infer<typeof nameObservationsSchema>;

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
