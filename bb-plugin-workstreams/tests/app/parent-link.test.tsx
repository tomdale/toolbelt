// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(cleanup);

async function mount({
  enabled = false,
  compact = false,
  lookup = () =>
    ({ id: "parent", title: "Parent work" }) as {
      id: string;
      title: string;
    } | null,
}: {
  enabled?: boolean;
  compact?: boolean;
  lookup?: () => { id: string; title: string } | null | Promise<never>;
} = {}) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  return renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "child", projectId: "project", isCompactViewport: compact },
    {
      settings: enabled ? { showParentThreadLink: true } : {},
      rpc: { parentLink: lookup },
    },
  );
}

it("stays hidden and silent when the setting is off", async () => {
  const slot = await mount();
  expect(slot.queryByRole("button")).toBeNull();
  expect(slot.inspection.rpcCalls).toHaveLength(0);
  slot.lifecycle.unmount();
});

it("links to the parent thread", async () => {
  const slot = await mount({ enabled: true });
  const button = await slot.findByRole("button", {
    name: "Go to parent thread: Parent work",
  });
  fireEvent.click(button);
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "toThread", threadId: "parent" },
  ]);
  slot.lifecycle.unmount();
});

it("hides for roots and failed lookups", async () => {
  for (const lookup of [
    () => null,
    () => Promise.reject(new Error("offline")),
  ]) {
    const slot = await mount({ enabled: true, lookup });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    expect(slot.queryByRole("button")).toBeNull();
    slot.lifecycle.unmount();
  }
});

it("collapses to an icon on compact viewports", async () => {
  const slot = await mount({ enabled: true, compact: true });
  const button = await slot.findByRole("button", {
    name: "Go to parent thread: Parent work",
  });
  expect(button.textContent).toBe("↖");
  slot.lifecycle.unmount();
});
