import type { ModelChoice, Prefs, PrefsPatch } from "../domain/prefs.ts";
import { DEFAULT_MODELS, mergePrefs, parsePrefs } from "../domain/prefs.ts";
import { getMeta, setMeta, type Database } from "./db.ts";

const KEY = "prefs";

export function hasPrefs(db: Database): boolean {
  return getMeta(db, KEY) !== null;
}

/** Converts values retained by BB's former declarative settings to prefs. */
export function migrateLegacyPrefs(values: unknown): Prefs {
  const old =
    values && typeof values === "object"
      ? (values as Record<string, unknown>)
      : {};
  const choice = (value: unknown, fallback: ModelChoice): ModelChoice =>
    typeof value === "string" && value.trim()
      ? { kind: "gateway", model: value.trim() }
      : fallback;
  return parsePrefs({
    sidebar: {
      showForYou: old.showForYou,
      showRecent: old.showRecent,
    },
    threads: {
      showParentLink: old.showParentThreadLink,
      autoTitle: old.autoTitle,
      analysisModel: choice(old.model, DEFAULT_MODELS.analysis),
    },
    newWork: {
      homeProjectId: old.homeProjectId,
      suggestionsModel: choice(old.model, DEFAULT_MODELS.suggestions),
    },
    organize: { model: choice(old.organizeModel, DEFAULT_MODELS.organize) },
    advanced: { hostId: old.hostId, debug: old.debug },
  });
}

/** Reads the stored shape, repairing malformed or older partial values. */
export function loadPrefs(db: Database): Prefs {
  const raw = getMeta(db, KEY);
  try {
    return parsePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return parsePrefs(null);
  }
}

/** Writes an initial snapshot only once, preserving users' former choices. */
export function seedPrefs(db: Database, values: unknown): Prefs {
  const existing = getMeta(db, KEY);
  if (existing !== null) return loadPrefs(db);
  const migrated = migrateLegacyPrefs(values);
  setMeta(db, KEY, JSON.stringify(migrated));
  return migrated;
}

/** Merges a validated patch and persists the clamped complete preference set. */
export function savePrefs(db: Database, patch: PrefsPatch): Prefs {
  const saved = mergePrefs(loadPrefs(db), patch);
  setMeta(db, KEY, JSON.stringify(saved));
  return saved;
}
