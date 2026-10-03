import { expect, it } from "vitest";
import {
  PHONE_QUERY,
  compactBlock,
  eyebrowMetrics,
  headingHeight,
  pinnedHeight,
} from "../../src/app/goalHeading.ts";

const BASE = 16;

it("keeps the workstream line one size and one height on a phone", () => {
  const phone = eyebrowMetrics(BASE, true);
  expect(phone.compactScale).toBe(1);
  // The compact heading reserves the same room for it as the expanded one,
  // so the line never moves between states.
  expect(phone.compactBlock).toBe(phone.expandedBlock);
});

it("sets the phone workstream line in BB's phone secondary size", () => {
  // `--text-xs` is 14px on phones, over the 12.8px (0.8 x 16) it has elsewhere.
  expect(eyebrowMetrics(BASE, true).size).toBe(14);
  expect(eyebrowMetrics(BASE, true).size).toBeGreaterThan(
    eyebrowMetrics(BASE, false).size,
  );
});

it("still shrinks the workstream line in the title bar away from a phone", () => {
  const desktop = eyebrowMetrics(BASE, false);
  expect(desktop.size).toBeCloseTo(12.8);
  expect(desktop.compactScale).toBeLessThan(1);
  expect(desktop.compactBlock).toBeLessThan(desktop.expandedBlock);
});

it("makes the pinned plate taller by the room the larger phone line needs", () => {
  const phone = pinnedHeight(BASE, eyebrowMetrics(BASE, true));
  const desktop = pinnedHeight(BASE, eyebrowMetrics(BASE, false));
  // The line reserves 20px on a phone instead of 10px in the title bar.
  expect(phone - desktop).toBe(10);
});

it("leaves the room reserved for a heading with no workstream alone", () => {
  expect(compactBlock(BASE, null)).toBeCloseTo(BASE * 0.95 * (4 / 3));
  expect(headingHeight(BASE, false, 1)).toBeLessThan(
    headingHeight(BASE, true, 1),
  );
  expect(headingHeight(BASE, true, 2)).toBeGreaterThan(
    headingHeight(BASE, true, 1),
  );
});

it("uses BB's own phone condition", () => {
  expect(PHONE_QUERY).toBe("(max-width: 767px) and (pointer: coarse)");
});
