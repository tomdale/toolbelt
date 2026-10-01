// @vitest-environment jsdom
import { expect, it } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
it("offers recaps and routing without background organization banners", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  expect(
    app.threadHeaderActions.some((a) => a.id === "workstream-proposal"),
  ).toBe(false);
  expect(
    app.composerCustomizations.some((a) => a.id === "automatic-filing"),
  ).toBe(false);
  expect(app.composerCustomizations.some((a) => a.id === "recap")).toBe(true);
  expect(app.composerCustomizations.some((a) => a.id === "router")).toBe(false);
  expect(app.composerCustomizations.some((a) => a.id === "new-work")).toBe(true);
});
