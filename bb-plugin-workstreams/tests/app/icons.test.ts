import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NO_WORKSTREAM_ICON,
  TAG_ICON,
  WORKSTREAM_ICON,
} from "../../src/app/workstream-icon.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const declared: Record<string, string> =
  manifest.bb.branding.experimental_icons;

describe("the plugin's declared icons", () => {
  // BB draws an icon name it doesn't know as a lightning bolt, so every name
  // the UI uses for a Workstreams entity must be declared in the manifest.
  it.each([
    ["workstream", WORKSTREAM_ICON],
    ["workstream-none", NO_WORKSTREAM_ICON],
    ["tag", TAG_ICON],
  ])("declares %s under the name the UI uses", (key, name) => {
    expect(name).toBe(`workstreams/${key}`);
    expect(declared[key]).toBeTruthy();
  });

  it("ships a themable SVG for every declared icon", () => {
    for (const path of Object.values(declared)) {
      const file = resolve(root, path);
      expect(existsSync(file), path).toBe(true);
      const svg = readFileSync(file, "utf8");
      expect(svg, path).toContain("<svg");
      // Drawn in the surrounding text color, not a fixed one.
      expect(svg, path).toContain("currentColor");
      expect(svg, path).not.toMatch(/(?:stroke|fill)="#[0-9a-f]{3,8}"/i);
    }
  });
});
