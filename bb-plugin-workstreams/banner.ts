/**
 * Generated banner art for workstream headers. One image per group, cached by
 * the group's normalized name, so a banner is only generated for a new group.
 * A shared style prompt and an accent color derived from the name keep the
 * series consistent while each motif stays distinct.
 */
export const IMAGE_MODEL = "openai/gpt-image-1-mini";
const BANNER_STYLE_VERSION = "v2";
const ACCENTS = [
  "muted teal",
  "warm amber",
  "soft coral",
  "dusty violet",
  "sage green",
  "steel blue",
  "faded rose",
  "ochre",
];
export function bannerCacheSignature(motif: string): string {
  return `${BANNER_STYLE_VERSION}:${motif}`;
}
export function bannerNeedsRegeneration(
  cachedSignature: string | undefined,
  motif: string,
): boolean {
  return cachedSignature !== bannerCacheSignature(motif);
}

export function bannerKey(group: string): string {
  return group
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
export function bannerPrompt(group: string, motif: string): string {
  let hash = 0;
  for (const c of bannerKey(group)) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const accent = ACCENTS[hash % ACCENTS.length];
  return `Abstract editorial illustration for a very wide dashboard banner, part of one consistent series. Style: flat geometric shapes, restrained matte texture, limited palette with ${accent} as the sole accent, no gradients or photorealism. Composition: one clear, recognizable motif placed only in the far right third; leave the left two-thirds very dark and visually quiet for white or dark UI text. Keep the motif large and simple enough to survive a 300-pixel-wide, 58-pixel-tall crop. Ensure the image remains subdued and legible when a dark or light translucent overlay is applied. Avoid tiny details and busy backgrounds. No text, letters, numbers, logos, interface elements, or borders. Motif: ${motif}.`;
}
