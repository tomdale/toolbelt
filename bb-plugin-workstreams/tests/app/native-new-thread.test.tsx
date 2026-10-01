// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(cleanup);

it("leaves vanilla New thread empty of Workstreams controls and side effects", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const route = vi.fn();
  const customizations = app.composerCustomizations.filter(
    (c) => !c.scopes || c.scopes.includes("new-thread"),
  );
  const slot = renderSlot(
    {
      component: function NativeSlots() {
        return customizations.flatMap((c) =>
          [...(c.banners ?? []), ...(c.actions ?? [])].map((item) => {
            const Component = item.component;
            return <Component key={`${c.id}:${item.id}`} />;
          }),
        );
      },
    },
    {},
    {
      composer: {
        text: "Fix the parser in my selected project",
        scope: { kind: "new-thread", projectId: "proj_selected" },
      },
      rpc: { route },
    },
  );
  await slot.behavior.setComposerText("Changed vanilla draft");
  expect(slot.container.innerHTML).toBe("");
  expect(slot.inspection.rpcCalls).toEqual([]);
  expect(slot.inspection.sdkCalls).toEqual([]);
  expect(slot.inspection.composer.selections).toEqual([]);
  expect(slot.inspection.composer.submits).toEqual([]);
  expect(route).not.toHaveBeenCalled();
});
