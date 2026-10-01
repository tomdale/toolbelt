// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { sidebarThread } from "./fixtures.ts";

afterEach(cleanup);

const family = () => [
  sidebarThread("parent", { title: "Parent work" }),
  sidebarThread("child", { title: "Child work", parentThreadId: "parent" }),
];

async function mount({
  enabled = false,
  compact = false,
  threads = family(),
}: {
  enabled?: boolean;
  compact?: boolean;
  threads?: PluginSidebarThread[];
} = {}) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  return renderSlot(
    app.threadHeaderActions.find((action) => action.id === "parent-thread")!,
    { threadId: "child", projectId: "proj_1", isCompactViewport: compact },
    {
      settings: {},
      rpc: {
        prefs: () => ({
          prefs: {
            sidebar: { showForYou: true, showRecent: true, recentLimit: 5 },
            threads: {
              autoTitle: true,
              analysisModel: { kind: "gateway", model: "m" },
              showParentLink: enabled,
            },
            newWork: {
              homeProjectId: "",
              suggestions: true,
              suggestionsModel: { kind: "gateway", model: "m" },
            },
            organize: { model: { kind: "gateway", model: "m" } },
            advanced: { hostId: "", debug: false },
          },
        }),
      },
      sidebarThreads: { threads },
    },
  );
}

it("stays hidden when the setting is off", async () => {
  const slot = await mount();
  expect(slot.queryByRole("button")).toBeNull();
  slot.lifecycle.unmount();
});

it("shows the parent's title and disc and opens the parent", async () => {
  const slot = await mount({ enabled: true });
  const button = await slot.findByRole("button", {
    name: "Back to parent: Parent work",
  });
  expect(button.textContent).toContain("‹");
  expect(button.textContent).toContain("Parent work");
  expect(button.querySelector(".ws-parent-link-disc")).not.toBeNull();
  fireEvent.click(button);
  expect(slot.inspection.sidebarActionCalls).toEqual([
    { method: "open", threadId: "parent" },
  ]);
  slot.lifecycle.unmount();
});

it("hides for roots and for parents outside the live thread set", async () => {
  for (const threads of [
    [sidebarThread("child", { title: "Child work" })],
    [sidebarThread("child", { parentThreadId: "missing" })],
  ]) {
    const slot = await mount({ enabled: true, threads });
    expect(slot.queryByRole("button")).toBeNull();
    slot.lifecycle.unmount();
  }
});

it("drops the title on compact viewports but keeps the accessible name", async () => {
  const slot = await mount({ enabled: true, compact: true });
  const button = await slot.findByRole("button", {
    name: "Back to parent: Parent work",
  });
  expect(button.textContent).toBe("‹");
  expect(button.querySelector(".ws-parent-link-disc")).not.toBeNull();
  slot.lifecycle.unmount();
});
