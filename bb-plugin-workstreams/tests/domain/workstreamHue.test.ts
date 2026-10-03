import { describe, expect, it } from "vitest";
import { workstreamHue } from "../../src/domain/workstreamHue.ts";

describe("workstreamHue", () => {
  it("is stable for an id", () => {
    expect(workstreamHue("sec_abc")).toBe(workstreamHue("sec_abc"));
  });

  it("stays on the color wheel", () => {
    for (const id of ["", "a", "sec_1", "ünïcode", "x".repeat(500)]) {
      const hue = workstreamHue(id);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("spreads sequential ids across the wheel", () => {
    const hues = Array.from({ length: 8 }, (_, i) => workstreamHue(`sec_${i}`));
    expect(new Set(hues).size).toBeGreaterThanOrEqual(7);
  });
});
