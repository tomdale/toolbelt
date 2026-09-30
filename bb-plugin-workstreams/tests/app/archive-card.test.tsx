// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, sidebarThread } from "./fixtures.ts";

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);
async function mount(
  options: {
    state?: string;
    revision?: number;
    analysisRevision?: number;
    dismissed?: boolean;
    text?: string;
    attachments?: number;
    reject?: boolean;
    patch?: Record<string, unknown>;
    status?: () => Promise<{ revision: number | null }>;
  } = {},
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const banner = app.composerCustomizations.find(
    (c) => c.id === "archive-suggestion",
  )!.actions![0]!;
  return renderSlot(
    banner,
    {},
    {
      composer: {
        scope: { kind: "thread", threadId: "t1" },
        text: options.text ?? "",
        attachmentCount: options.attachments ?? 0,
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
          analysis: {
            t1: {
              recap: "Finished",
              state: options.state ?? "done",
              revision: options.analysisRevision ?? 500,
            },
          },
        }),
        archiveStatus:
          options.status ??
          (() => ({
            revision: options.dismissed
              ? null
              : (options.analysisRevision ?? 500),
          })),
        archiveSuggestion: () => {
          if (options.reject) throw new Error("Thread has new work");
          return { ok: true };
        },
      },
    },
  );
}

it("shows only a grey direct archive button without a card, dialog, or message action", async () => {
  const slot = await mount();
  const button = await slot.findByRole("button", { name: "Archive thread" });
  expect(button.className).toBe("ws-archive-button");
  expect(slot.container.textContent).toBe("Archive");
  expect(slot.container.contains(document.activeElement)).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(slot.queryByRole("button")).toBeNull());
  expect(
    slot.inspection.rpcCalls.find((c) => c.method === "archiveSuggestion")
      ?.input,
  ).toEqual({ threadId: "t1", revision: 500, action: "archive" });
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  expect(app.messageActions.some((a) => a.id === "archive-review")).toBe(false);
  expect(app.threadPanelActions.some((a) => a.id === "archive-review")).toBe(
    false,
  );
  slot.lifecycle.unmount();
});

it.each([
  { state: "review" },
  { revision: 600 },
  { dismissed: true },
  { text: "Continue working" },
  { attachments: 1 },
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
  expect(slot.queryByRole("button")).toBeNull();
  slot.lifecycle.unmount();
});

it("typing dismisses the completed turn and clearing or remounting cannot resurrect it", async () => {
  const slot = await mount();
  await slot.findByRole("button", { name: "Archive thread" });
  await slot.behavior.setComposerText("Another task");
  expect(slot.queryByRole("button")).toBeNull();
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "archiveSuggestion")
        ?.input,
    ).toEqual({ threadId: "t1", revision: 500, action: "dismiss" }),
  );
  await slot.behavior.setComposerText("");
  expect(slot.queryByRole("button")).toBeNull();
  slot.lifecycle.unmount();
  const remount = await mount();
  await waitFor(() =>
    expect(remount.inspection.rpcCalls.some((c) => c.method === "state")).toBe(
      true,
    ),
  );
  expect(remount.queryByRole("button")).toBeNull();
  remount.lifecycle.unmount();
  const later = await mount({ revision: 600, analysisRevision: 600 });
  await later.findByRole("button", { name: "Archive thread" });
  later.lifecycle.unmount();
});

it("dismisses even when typing starts before eligibility returns", async () => {
  let resolve!: (value: { revision: number | null }) => void;
  const slot = await mount({
    status: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "archiveStatus"),
    ).toBe(true),
  );
  await slot.behavior.setComposerText("Continue");
  await slot.behavior.setComposerText("");
  resolve({ revision: 500 });
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "archiveSuggestion"),
    ).toBe(true),
  );
  expect(slot.queryByRole("button")).toBeNull();
  slot.lifecycle.unmount();
});

it("keeps archive failures visible without hiding the retry button", async () => {
  const slot = await mount({ reject: true });
  fireEvent.click(await slot.findByRole("button", { name: "Archive thread" }));
  await slot.findByRole("alert");
  expect(slot.getByRole("button", { name: "Archive thread" })).not.toBeNull();
  slot.lifecycle.unmount();
});
