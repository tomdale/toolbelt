/**
 * Generated banner art for workstream headers. One image per group, cached by
 * the group's normalized name, so a banner is only generated for a new group.
 * A shared style prompt and an accent color derived from the name keep the
 * series consistent while each motif stays distinct.
 */
export const IMAGE_MODEL = "openai/gpt-image-1-mini";
const BANNER_STYLE_VERSION = "v3";
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
  return `Create a restrained, wide horizontal editorial illustration in a consistent series. The ENTIRE background must be solid deep charcoal (#17191c), including the left side; no white, cream, pale, or light-colored background. Use flat matte shapes with subtle paper grain; one muted ${accent} accent plus charcoal and at most one warm neutral. Put one single, concrete physical-world metaphor in the far right third, leaving the left two-thirds nearly empty charcoal. The motif must remain recognizable when cropped to a narrow 300 x 58 pixel strip. This is NOT a UI mockup: absolutely no panels, cards, windows, screens, buttons, interface layouts, icons, labels, charts, diagrams, text-like lines, glyphs, or letters. Avoid generic technology imagery (circuits, connected nodes, gears). Avoid multiple objects or repeated shapes that could resemble a list. No gradients, horizon, sky, clouds, or large pale areas. Motif: ${motif}.`;
}
