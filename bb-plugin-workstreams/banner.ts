/**
 * Generated banner art for workstream headers. One image per group, cached by
 * the group's normalized name, so a banner is only generated for a new group.
 * A shared style prompt and an accent color derived from the name keep the
 * series consistent while each motif stays distinct.
 */
export const IMAGE_MODEL = "openai/gpt-image-1-mini";
/** Source image for composition is kept separate from code-rendered title/icon. */
export const HOTLINE_ART_PROMPT_VERSION = "hotline-art-v1";
const BANNER_STYLE_VERSION = "hotline-ik0n-v3";
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
/** The final banner also contains the exact, code-rendered product name. */
export function hotlineBannerSignature(group: string, motif: string): string {
  return `${BANNER_STYLE_VERSION}:${motif}:${bannerKey(group)}`;
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
const MOTIFS: Record<string, string> = {
  bb: "one amber thread branching into three distinct paths",
  tomdaleos: "open field notebook with a small brass compass",
  workstreams: "copper thread and red pencil over black paper",
  "engineering-full-stack-collab":
    "two wooden bridges meeting over a narrow stream",
  "vercel-agent": "orange rocket plume over a night sky",
  dockside: "single moored sailboat with a curved rope",
  "cross-project-coordination": "compass needle over three offset map contours",
  "bb-recap": "rolled paper scroll with one folded corner",
  "sidebar-hierarchy": "three nested cut-paper archways",
  "bb-agent-plugins-loader":
    "open wooden crate with one thread passing through",
  fx: "single radar ring with one sweeping arc",
  workforest: "quiet forest canopy with a shaft of dawn light",
  v0: "folded paper prototype with one sharp crease",
  "markdown-viewer": "open blank book with one ribbon bookmark",
};
/** Product-specific creative direction for handmade late-90s Hotline strips. */
export function bannerMotif(group: string, suggested: string): string {
  return MOTIFS[bannerKey(group)] ?? suggested;
}
export function bannerPrompt(group: string, suggested: string): string {
  const motif = bannerMotif(group, suggested);
  let hash = 0;
  for (const c of bannerKey(group)) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const accent = ACCENTS[hash % ACCENTS.length];
  return `Generate ART TEXTURE ONLY for a classic Hotline Connect ik0n, 232x18-pixel server banner. Handmade 1998 Macintosh shareware aesthetic: vivid brushed chrome, neon, marble, woodgrain, flag colors, or photo-fragment textures; loud saturated ${accent}, hard gradients, bevels and dithering. This is a very short horizontal strip, NOT a poster. Put one recognizable product motif into a narrow horizontal band through the EXACT CENTER of the image: all identifying artwork should lie within the middle 12 percent of image height so a center-slice crop retains it. Let color/texture bleed across the full width, with some brighter texture at both ends. Motif: ${motif}. No text, letters, words, typography, logos, panels, cards, UI, or white empty sky. Artwork may be busy and high contrast; exact name text and left icon will be composited in code.`;
}
