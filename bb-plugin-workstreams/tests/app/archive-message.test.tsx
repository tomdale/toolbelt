// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, sidebarThread } from "./fixtures.ts";

afterEach(cleanup);
it("opens host panel from the message action without archiving", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const action = app.messageActions.find((a) => a.id === "archive-review")!;
  const openPanel = vi.fn(() => true);
  await action.run({
    threadId: "t1",
    message: {
      id: "m1",
      threadId: "t1",
      role: "assistant",
      text: "Done",
      sourceSeqEnd: 10,
    },
    openPanel,
  });
  expect(openPanel).toHaveBeenCalledWith({
    actionId: "archive-review",
    title: "Archive thread",
  });
});

it.each([true, false])(
  "offers archive only for eligible threads: %s",
  async (eligible) => {
    const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
    const slot = renderSlot(
      app.threadPanelActions.find((a) => a.id === "archive-review")!,
      { threadId: "t1", params: null },
      {
        sidebarThreads: {
          status: "ready",
          threads: [sidebarThread("t1", { latestAttentionAt: 500 })],
          sections: [],
          projects: [],
        },
        rpc: {
          state: () => ({
            ...emptyState(),
            analysis: { t1: { state: "done", revision: 500 } },
          }),
          archiveStatus: () => ({ revision: eligible ? 500 : null }),
          archiveSuggestion: () => ({ ok: true }),
        },
      },
    );
    if (eligible) {
      fireEvent.click(
        await slot.findByRole("button", { name: "Archive thread" }),
      );
      await waitFor(() =>
        expect(
          slot.inspection.rpcCalls.find((c) => c.method === "archiveSuggestion")
            ?.input,
        ).toEqual({ threadId: "t1", revision: 500, action: "archive" }),
      );
    } else {
      await waitFor(() =>
        expect(
          slot.inspection.rpcCalls.some((c) => c.method === "archiveStatus"),
        ).toBe(true),
      );
      expect(slot.queryByRole("button", { name: "Archive thread" })).toBeNull();
    }
    slot.lifecycle.unmount();
  },
);
