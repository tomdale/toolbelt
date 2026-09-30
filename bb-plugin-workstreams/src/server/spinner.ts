import { parseSpinner, type SpinnerStyle } from "../domain/spinner.ts";
import { getMeta, setMeta, type Database } from "./db.ts";

/**
 * The working indicator's style. It lives in plugin storage rather than a
 * declarative setting because BB draws settings as plain text, and the style
 * is chosen by looking at live spinners in the plugin's settings section.
 */
const KEY = "spinner";

export const loadSpinner = (db: Database): SpinnerStyle =>
  parseSpinner(getMeta(db, KEY));

export function saveSpinner(db: Database, style: SpinnerStyle): SpinnerStyle {
  const saved = parseSpinner(style);
  setMeta(db, KEY, JSON.stringify(saved));
  return saved;
}
