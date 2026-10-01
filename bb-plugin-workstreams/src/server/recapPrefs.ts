import { parseRecapPrefs, type RecapPrefs } from "../domain/recapPrefs.ts";
import { getMeta, setMeta, type Database } from "./db.ts";

const KEY = "recapPrefs";
const SINCE_KEY = "recapToolSince";

/**
 * When agents last started getting the recap tool: first load, or turning
 * recaps back on. A thread created since then has had the tool from its
 * first session.
 */
export function recapToolSince(db: Database, now = Date.now()): number {
  const raw = Number(getMeta(db, SINCE_KEY));
  if (Number.isFinite(raw) && raw > 0) return raw;
  setMeta(db, SINCE_KEY, String(now));
  return now;
}

export function loadRecapPrefs(db: Database): RecapPrefs {
  const raw = getMeta(db, KEY);
  try {
    return parseRecapPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return parseRecapPrefs(null);
  }
}

/** Merges `patch` into the stored preferences, clamping out-of-range values. */
export function saveRecapPrefs(
  db: Database,
  patch: Partial<RecapPrefs>,
): RecapPrefs {
  const before = loadRecapPrefs(db);
  const saved = parseRecapPrefs({ ...before, ...patch });
  setMeta(db, KEY, JSON.stringify(saved));
  if (saved.required && !before.required)
    setMeta(db, SINCE_KEY, String(Date.now()));
  return saved;
}
