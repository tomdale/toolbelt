import { expect, it } from "vitest";
import { parseRecapPrefs } from "../../src/domain/recapPrefs.ts";

it("fills defaults for missing or invalid preferences", () => {
  expect(parseRecapPrefs(null)).toEqual({
    required: true,
    corrections: 3,
    layout: "full",
    hashDigits: null,
    hashLetters: null,
  });
  expect(parseRecapPrefs({ layout: "huge", required: "yes" })).toMatchObject({
    required: true,
    layout: "full",
  });
});

it("keeps a stored minimal layout and reads other stored layouts as full", () => {
  expect(parseRecapPrefs({ layout: "minimal" }).layout).toBe("minimal");
  expect(parseRecapPrefs({ layout: "compact" }).layout).toBe("full");
});

it("clamps reminders to their range", () => {
  expect(parseRecapPrefs({ corrections: 99 }).corrections).toBe(10);
  expect(parseRecapPrefs({ corrections: -1 }).corrections).toBe(0);
});

it("keeps valid hash colors and drops invalid ones", () => {
  const prefs = parseRecapPrefs({ hashDigits: "#336699", hashLetters: "red" });
  expect(prefs.hashDigits).toBe("#336699");
  expect(prefs.hashLetters).toBeNull();
});
