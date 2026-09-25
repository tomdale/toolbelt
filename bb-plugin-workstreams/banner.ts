/**
 * Generated banner art for workstream headers. One image per group, cached by
 * the group's normalized name, so a banner is only generated for a new group.
 * A shared style prompt and an accent color derived from the name keep the
 * series consistent while each motif stays distinct.
 */
export const IMAGE_MODEL = "openai/gpt-image-1-mini";
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
  return `Abstract editorial illustration for a very wide dashboard banner, part of a consistent series. Style: flat minimal shapes with soft grain, deep charcoal background, a single ${accent} accent with subtle tints, calm and low contrast. Composition: the motif sits in the right half; the left half is almost empty dark background. No text, letters, numbers, logos, or interface elements. Motif: ${motif}.`;
}
