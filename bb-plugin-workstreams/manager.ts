const MANAGER_SUFFIX = /\s*[—–-]\s*manager(?:\s*\([^)]*\))?\s*$/i;

/** Returns a product label when a thread title carries an explicit manager role. */
export function managerName(title: string): string | null {
  const match = MANAGER_SUFFIX.exec(title);
  return match ? title.slice(0, match.index).trim() || null : null;
}

export function isManagerTitle(title: string): boolean {
  return managerName(title) !== null;
}
