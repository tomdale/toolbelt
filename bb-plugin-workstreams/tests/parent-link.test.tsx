// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(cleanup);

async function mount({
  enabled = false,
  compact = false,
  threadId = "child",
  lookup = () => ({ id: "parent", title: "Parent work" }),
}: {
  enabled?: boolean;
  compact?: boolean;
  threadId?: string;
  lookup?: () => { id: string; title: string } | null | Promise<never>;
} = {}) {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(
    app.threadHeaderActions[0],
    { threadId, projectId: "project", isCompactViewport: compact },
    {
      settings: enabled ? { showParentThreadLink: true } : {},
      rpc: { parentLink: lookup },
    },
  );
}

it("hides by default without requesting a parent", async () => {
  const slot = await mount();
  expect(slot.queryByRole("button")).toBeNull();
  expect(slot.inspection.rpcCalls).toHaveLength(0);
  slot.lifecycle.unmount();
});

it("shows the parent title and navigates in the current pane", async () => {
  const slot = await mount({ enabled: true });
  const button = await slot.findByRole("button", {
    name: "Go to parent thread: Parent work",
  });
  expect(button.textContent).toContain("Parent work");
  fireEvent.click(button);
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "toThread", threadId: "parent" },
  ]);
  slot.lifecycle.unmount();
});

it("hides for a root, missing parent, or lookup failure", async () => {
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

it("uses an icon-sized control with a descriptive name on compact viewports", async () => {
  const slot = await mount({ enabled: true, compact: true });
  const button = await slot.findByRole("button", {
    name: "Go to parent thread: Parent work",
  });
  expect(button.textContent).toBe("↖");
  slot.lifecycle.unmount();
});
