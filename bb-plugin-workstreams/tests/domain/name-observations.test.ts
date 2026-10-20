import { describe, expect, it } from "vitest";
import {
  aggregateNames,
  parseNameObservations,
} from "../../src/domain/name-observations.ts";

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

describe("parseNameObservations", () => {
  it("keeps products when features are written as bare names", () => {
    // The shape a model returned for a real run: only the objects were asked for.
    expect(
      parseNameObservations({
        products: ["bb", "bb-plugin-walkthrough"],
        features: ["Walkthrough pane", "pop-out button"],
      }),
    ).toEqual({
      products: ["bb", "bb-plugin-walkthrough"],
      features: [
        { name: "Walkthrough pane", product: null },
        { name: "pop-out button", product: null },
      ],
    });
  });

  it("drops only the entries that are unusable", () => {
    expect(
      parseNameObservations({
        products: ["  Lumen  ", 7, "", "x".repeat(101), null, "BB"],
        features: [
          { name: "Cache", product: "Lumen" },
          { name: "Export", product: 7 },
          { name: "Sync" },
          { name: "", product: "Lumen" },
          { product: "Lumen" },
          ["Nested"],
          42,
          "Search",
        ],
      }),
    ).toEqual({
      products: ["Lumen", "BB"],
      features: [
        { name: "Cache", product: "Lumen" },
        { name: "Export", product: null },
        { name: "Sync", product: null },
        { name: "Search", product: null },
      ],
    });
  });

  it("caps each list and reads anything that is not a record as no names", () => {
    const many = Array.from({ length: 60 }, (_, i) => `Name ${i}`);
    const parsed = parseNameObservations({ products: many, features: many });
    expect(parsed.products).toEqual(many.slice(0, 40));
    expect(parsed.features).toHaveLength(40);
    for (const raw of [undefined, null, "Lumen", 3, ["Lumen"]])
      expect(parseNameObservations(raw)).toEqual({
        products: [],
        features: [],
      });
    expect(parseNameObservations({ products: "Lumen", features: {} })).toEqual({
      products: [],
      features: [],
    });
  });
});
