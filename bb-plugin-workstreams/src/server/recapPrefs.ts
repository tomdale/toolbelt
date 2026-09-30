import { parseRecapPrefs, type RecapPrefs } from "../domain/recapPrefs.ts";
import { getMeta, setMeta, type Database } from "./db.ts";

const KEY = "recapPrefs";

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
  const saved = parseRecapPrefs({ ...loadRecapPrefs(db), ...patch });
  setMeta(db, KEY, JSON.stringify(saved));
  return saved;
}
