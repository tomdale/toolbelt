import { expect, it } from "vitest";
import { aggregateNames } from "../../src/domain/name-observations.ts";

it("aggregates case-insensitively per run and keeps ambiguous feature associations separate", () => {
  const names = aggregateNames([
    {
      at: 10,
      names: {
        products: ["BB", "bb"],
        features: [
          { name: "Recaps", product: "BB" },
          { name: "recaps", product: "bb" },
          { name: "Export", product: null },
        ],
      },
    },
    {
      at: 20,
      names: {
        products: [],
        features: [
          { name: "Recaps", product: "BB" },
          { name: "Recaps", product: "Other" },
        ],
      },
    },
  ]);
  expect(names.products).toEqual([
    { name: "bb", firstSeenAt: 10, lastSeenAt: 20, runs: 2 },
    { name: "Other", firstSeenAt: 20, lastSeenAt: 20, runs: 1 },
  ]);
  expect(names.features).toHaveLength(3);
  expect(
    names.features.find((feature) => feature.product === "bb"),
  ).toMatchObject({ runs: 2 });
  expect(
    names.features.find((feature) => feature.name === "Export"),
  ).toMatchObject({ product: null, runs: 1 });
});
