import { expect, it } from "vitest";
import {
  bannerCacheSignature,
  bannerMotif,
  bannerNeedsRegeneration,
  bannerPrompt,
} from "../banner";

it("curates physical, product-specific motifs over generic or UI-like suggestions", () => {
  expect(
    bannerMotif("Vercel Agent", "blueprints and gears over circuit board"),
  ).toBe("small launch plume lifting a folded paper plane");
  expect(
    bannerMotif("New Product", "cards with text lines in a dashboard"),
  ).toBe("abstract folded paper shapes inspired by New Product");
  expect(bannerMotif("New Product", "paper kite in a coastal wind")).toBe(
    "paper kite in a coastal wind",
  );
});
it("uses a dark, empty-left, physical-object prompt and versions the cache", () => {
  const prompt = bannerPrompt("Workstreams", "nested cards with tabs");
  expect(prompt).toContain("uniform near-black charcoal (#17191c)");
  expect(prompt).toContain("left 70 percent stays empty charcoal");
  expect(prompt).toContain("one red thread weaving through layered paper tabs");
  expect(bannerCacheSignature("motif")).toMatch(/^v4:/);
  expect(bannerNeedsRegeneration("v3:motif", "motif")).toBe(true);
  expect(bannerNeedsRegeneration("v4:motif", "motif")).toBe(false);
});
