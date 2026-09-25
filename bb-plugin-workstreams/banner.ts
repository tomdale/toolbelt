/**
 * Generated banner art for workstream headers. One image per group, cached by
 * the group's normalized name, so a banner is only generated for a new group.
 * A shared style prompt and an accent color derived from the name keep the
 * series consistent while each motif stays distinct.
 */
export const IMAGE_MODEL = "openai/gpt-image-1-mini";
const BANNER_STYLE_VERSION = "v4";
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
const MOTIFS: Record<string, string> = {
  bb: "one amber thread branching into three distinct paths",
  tomdaleos: "open field notebook with a small brass compass",
  workstreams: "one red thread weaving through layered paper tabs",
  "engineering-full-stack-collab":
    "two wooden bridges meeting over a narrow stream",
  "vercel-agent": "small launch plume lifting a folded paper plane",
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
const TOO_GENERIC =
  /\b(?:circuit|node|gear|card|panel|window|screen|ui|dashboard|snippet|flowchart|text|line)s?\b/i;
/** Prefer physical, product-specific motifs over UI-shaped model suggestions. */
export function bannerMotif(group: string, suggested: string): string {
  const curated = MOTIFS[bannerKey(group)];
  if (curated) return curated;
  return TOO_GENERIC.test(suggested)
    ? `abstract folded paper shapes inspired by ${group}`
    : suggested;
}
export function bannerPrompt(group: string, suggested: string): string {
  const motif = bannerMotif(group, suggested);
  let hash = 0;
  for (const c of bannerKey(group)) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const accent = ACCENTS[hash % ACCENTS.length];
  return `Create a restrained, wide horizontal illustration in a consistent series. Background: uniform near-black charcoal (#17191c), edge to edge. Never use a white, cream, pale, bright, or sky background. Flat matte cut-paper shapes, subtle grain, muted ${accent} accent, very low contrast. One simple physical object only, recognizable at 300x58 crop, placed at the far right; left 70 percent stays empty charcoal. No interface, UI, windows, panels, cards, screens, charts, diagrams, symbols, glyphs, pseudo-text, strokes that resemble writing, repeated list-like objects, circuits, nodes, gears, gradients, horizon, or clouds. Motif: ${motif}.`;
}
