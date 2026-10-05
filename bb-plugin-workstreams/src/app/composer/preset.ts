/**
 * The workstream whose ＋ opened the New thread composer. The sidebar sets it
 * just before navigating, and the composer's banner takes it when it mounts,
 * so the new thread starts with that workstream's topic. Both run in this
 * plugin's one client bundle, so a module value carries it; it expires
 * quickly so a later, unrelated New thread doesn't pick it up.
 */
const PRESET_TTL_MS = 10_000;

let preset: { sectionId: string; label: string; at: number } | null = null;

export function setComposerPreset(sectionId: string, label: string): void {
  preset = { sectionId, label, at: Date.now() };
}

export function takeComposerPreset(): {
  sectionId: string;
  label: string;
} | null {
  const current = preset;
  preset = null;
  if (!current || Date.now() - current.at > PRESET_TTL_MS) return null;
  return { sectionId: current.sectionId, label: current.label };
}
