/**
 * Generated banner art for workstream headers. One image per group, cached by
 * the group's normalized name, so a banner is only generated for a new group.
 * A shared style prompt and an accent color derived from the name keep the
 * series consistent while each motif stays distinct.
 */
export const IMAGE_MODEL = "openai/gpt-image-1-mini";
/** Source image for composition is kept separate from code-rendered title/icon. */
export const HOTLINE_ART_PROMPT_VERSION = "hotline-art-v1";
const BANNER_STYLE_VERSION = "hotline-ik0n-v7";
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
  bb: "golden BB monogram built from interlocking beveled ovals on chrome",
  tomdaleos: "compass rose beside a tiny diskette on blue enamel",
  workstreams: "one quill writing a copper thread with an ink spark",
  "engineering-full-stack-collab":
    "two steel bridges meeting over electric blue water",
  "vercel-agent": "bold orange paper rocket over midnight blue enamel",
  dockside: "chrome boat cleat with one taut coral rope on sea glass",
  "cross-project-coordination": "brass compass rose over folded emerald maps",
  "bb-recap": "small red wax seal on parchment and chrome",
  "sidebar-hierarchy": "three nested chrome chevrons over dark teal enamel",
  "bb-agent-plugins-loader": "violet key sliding into a chrome toolbox latch",
  fx: "single red radar sweep across brushed aluminum",
  workforest: "emerald leaf silhouette on black and lime marble",
  v0: "bright orange folded paper prototype on violet enamel",
  "markdown-viewer": "cream open-book silhouette on cobalt chrome",
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
  return `Make a classic 1998 Macintosh Hotline Connect ik0n server banner. IMPORTANT: image output aspect ratio must be the widest horizontal strip option available, ideally 3:1 or wider. Do not create a square or portrait poster. We will center-crop further in code without stretching. Art only: absolutely no words, lettering, typography, fake text, logos, or interface panels. Late 90s handmade Mac shareware: rich ${accent} brushed chrome, marble, neon, metal flake or photo fragments, bevels and light dithering. One recognizable physical emblem inspired by this product: ${motif}. Keep image detailed and colorful across its entire width; code overlays title and icon.`;
}
