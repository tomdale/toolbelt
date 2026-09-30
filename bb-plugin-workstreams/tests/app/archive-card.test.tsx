// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import type { ComponentType } from "react";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, sidebarThread } from "./fixtures.ts";

afterEach(cleanup);
async function mount(
  options: {
    style?: string;
    surface?: "banner" | "header" | "action";
    state?: string;
    revision?: number;
    dismissed?: boolean;
    text?: string;
    reject?: boolean;
    patch?: Record<string, unknown>;
  } = {},
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const custom = app.composerCustomizations.find(
    (c) => c.id === "archive-suggestion",
  )!;
  const surface =
    options.surface === "header"
      ? app.threadHeaderActions.find((a) => a.id === "archive-suggestion")!
      : options.surface === "action"
        ? custom.actions![0]!
        : custom.banners![0]!;
  return renderSlot(
    surface as { component: ComponentType<PluginThreadHeaderActionProps> },
    { threadId: "t1", projectId: "proj_1", isCompactViewport: false },
    {
      settings: { archiveSuggestionStyle: options.style ?? "floating" },
      composer: {
        scope: { kind: "thread", threadId: "t1" },
        text: options.text ?? "",
      },
      sidebarThreads: {
        status: "ready",
        threads: [
          sidebarThread("t1", {
            latestAttentionAt: options.revision ?? 500,
            ...options.patch,
          }),
        ],
        sections: [],
        projects: [],
      },
      rpc: {
        state: () => ({
          ...emptyState(),
          archiveSuggestions: options.dismissed ? {} : { t1: 500 },
          analysis: {
            t1: {
              recap: "Finished",
              state: options.state ?? "done",
              revision: 500,
            },
          },
        }),
        archiveStatus: () => ({ revision: options.dismissed ? null : 500 }),
        archiveSuggestion: () => {
          if (options.reject) throw new Error("Thread has new work");
          return { ok: true };
        },
      },
    },
  );
}

it.each(["archive", "dismiss"] as const)(
  "offers a bottom card and handles %s without sending a message",
  async (action) => {
    const slot = await mount();
    const button = await slot.findByRole("button", {
      name: action === "archive" ? "Archive thread" : "Dismiss",
    });
    expect(slot.getByRole("status").textContent).toContain(
      "no outstanding work",
    );
    expect(slot.container.querySelector(".ws-archive-anchor")).not.toBeNull();
    expect(slot.container.contains(document.activeElement)).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(slot.queryByRole("button")).toBeNull());
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "archiveSuggestion")
        ?.input,
    ).toEqual({ threadId: "t1", revision: 500, action });
    slot.lifecycle.unmount();
  },
);

it.each([
  { state: "review" },
  { revision: 600 },
  { dismissed: true },
  { text: "Actually, keep working" },
  { patch: { status: "active" } },
  { patch: { queuedWork: "waiting" } },
  { patch: { hasPendingInteraction: true } },
  { patch: { activity: { goals: 1 } } },
])("hides unsafe or unwanted suggestions: %j", async (options) => {
  const slot = await mount(options);
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.some((c) => c.method === "state")).toBe(
      true,
    ),
  );
  expect(slot.queryByRole("status")).toBeNull();
  slot.lifecycle.unmount();
});

it("hides while drafting a continuation and shows again when cleared", async () => {
  const slot = await mount();
  await slot.findByRole("button", { name: "Archive thread" });
  await slot.behavior.setComposerText("Another task");
  expect(slot.queryByRole("status")).toBeNull();
  await slot.behavior.setComposerText("");
  await slot.findByRole("button", { name: "Archive thread" });
  slot.lifecycle.unmount();
});

it("renders the inline option without a floating card", async () => {
  const slot = await mount({ style: "inline" });
  await slot.findByRole("button", { name: "Archive thread" });
  expect(slot.container.querySelector(".ws-archive-card")).toBeNull();
  fireEvent.click(
    slot.getByRole("button", { name: "Dismiss archive suggestion" }),
  );
  await waitFor(() => expect(slot.queryByRole("status")).toBeNull());
  slot.lifecycle.unmount();
});

it.each(["header", "action"] as const)(
  "only opens %s review after clicking, and can keep the thread open",
  async (surface) => {
    const slot = await mount({ style: surface, surface });
    const trigger = await slot.findByRole("button", {
      name: "Review archive suggestion",
    });
    expect(slot.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    await slot.findByRole("dialog");
    fireEvent.click(slot.getByRole("button", { name: "Keep open" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "archiveSuggestion")
        ?.input,
    ).toEqual({ threadId: "t1", revision: 500, action: "dismiss" });
    slot.lifecycle.unmount();
  },
);

it.each(["off", "header", "action"])(
  "does not show a composer banner for %s",
  async (style) => {
    const slot = await mount({ style });
    expect(slot.queryByRole("status")).toBeNull();
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "archiveStatus"),
    ).toBe(false);
    slot.lifecycle.unmount();
  },
);

it("keeps the card open and shows failures", async () => {
  const slot = await mount({ reject: true });
  fireEvent.click(await slot.findByRole("button", { name: "Archive thread" }));
  await slot.findByText("Thread has new work");
  expect(slot.getByRole("button", { name: "Archive thread" })).not.toBeNull();
  slot.lifecycle.unmount();
});
