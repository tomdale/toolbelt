import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

describe("standalone package", () => {
  it("uses public SDK surfaces and package-local imports", async () => {
    const result = await experimental_scanPublicSdkOnly(fileURLToPath(new URL("../", import.meta.url)), {
      allow: [/^react$/, /^vitest(?:\/config)?$/, /^@testing-library\/react$/, /^@radix-ui\/react-slot$/, /^(?:class-variance-authority|clsx|tailwind-merge)$/, /^@\//],
    });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
