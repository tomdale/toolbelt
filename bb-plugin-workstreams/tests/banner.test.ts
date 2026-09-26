import { expect, it, test } from "vitest";
import { cropGeometry, hotlineBannerSvg } from "../hotline-banner";
import {
  bannerCacheSignature,
  bannerMotif,
  bannerNeedsRegeneration,
  bannerPrompt,
} from "../banner";

it("curates distinctive Hotline art motifs per product", () => {
  expect(bannerMotif("Vercel Agent", "some generic suggestion")).toBe(
    "bold orange paper rocket over midnight blue enamel",
  );
  expect(bannerMotif("New Product", "paper kite in a coastal wind")).toBe(
    "paper kite in a coastal wind",
  );
});
it("uses the 1998 Hotline art-strip prompt and bumps the cache version", () => {
  const prompt = bannerPrompt("Workstreams", "ignored suggestion");
  expect(prompt).toContain("widest horizontal strip option available");
  expect(prompt).toContain("Late 90s handmade Mac shareware");
  expect(prompt).toContain(
    "one quill writing a copper thread with an ink spark",
  );
  expect(bannerCacheSignature("motif")).toMatch(/^hotline-ik0n-v7:/);
  expect(bannerNeedsRegeneration("hotline-ik0n-v6:motif", "motif")).toBe(true);
  expect(bannerNeedsRegeneration("hotline-ik0n-v7:motif", "motif")).toBe(false);
});

test("composites a crisp Hotline strip with code-rendered name and product glyph", () => {
  const svg = hotlineBannerSvg("Vercel Agent", "image/png", "YWJj");
  expect(svg).toContain('width="696" height="54" viewBox="0 0 232 18"');
  expect(svg).toContain("VERCEL AGENT");
  expect(svg).toContain('aria-label="Vercel Agent"');
  expect(svg).toContain('text-anchor="end"');
  expect(svg).not.toContain("textLength=");
  expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
  expect(svg).toContain("data:image/png;base64,YWJj");
});
test("crops wide artwork without non-uniform scaling", () => {
  expect(cropGeometry(1536, 1024)).toEqual({
    width: 1536,
    height: 119,
    left: 0,
    top: 380,
  });
  expect(cropGeometry(3000, 500)).toEqual({
    width: 3000,
    height: 232,
    left: 0,
    top: 112,
  });
});
