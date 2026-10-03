/**
 * The hue (0–359°) that identifies a workstream wherever it is drawn. It is a
 * pure function of the workstream's id, so a workstream keeps its color across
 * sessions and machines without storing anything, and renaming it does not
 * change it.
 */
export function workstreamHue(id: string): number {
  // FNV-1a, then a final avalanche so near-identical ids (ws-1, ws-2) land far
  // apart on the color wheel.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return (hash >>> 0) % 360;
}
