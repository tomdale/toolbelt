import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPINNER,
  parseSpinner,
  trackCss,
} from "../../src/domain/spinner.ts";

describe("parseSpinner", () => {
  it("reads a stored style and ignores unknown parts", () => {
    expect(
      parseSpinner(
        JSON.stringify({
          shape: "orbit",
          primary: "#AbCdEf",
          secondary: "none",
        }),
      ),
    ).toEqual({ shape: "orbit", primary: "#AbCdEf", secondary: "none" });
    expect(
      parseSpinner({ shape: "wobble", primary: "red", secondary: "url(x)" }),
    ).toEqual(DEFAULT_SPINNER);
    expect(parseSpinner(null)).toEqual(DEFAULT_SPINNER);
  });
});

describe("trackCss", () => {
  it("fades the primary color, draws nothing, or uses the pick", () => {
    expect(trackCss({ ...DEFAULT_SPINNER, primary: "#102030" })).toBe(
      "color-mix(in oklab, #102030 22%, transparent)",
    );
    expect(trackCss({ ...DEFAULT_SPINNER, secondary: "none" })).toBe(
      "transparent",
    );
    expect(trackCss({ ...DEFAULT_SPINNER, secondary: "#000000" })).toBe(
      "#000000",
    );
  });
});
