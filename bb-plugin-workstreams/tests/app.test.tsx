// @vitest-environment jsdom
import { it, expect, afterEach } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { View } from "../server";

afterEach(cleanup);
const initial: View = {
  threads: [
    {
      id: "1",
      title: "Fix Slack replies",
      project: "agents",
      repository: null,
      status: "idle",
      updatedAt: 1,
      sectionId: null,
    },
    {
      id: "2",
      title: "Update API auth",
      project: "api",
      repository: null,
      status: "active",
      updatedAt: 1,
      sectionId: null,
    },
  ],
  analysis: null,
  progress: null,
  error: null,
  fixture: null,
  log: [],
  banners: {},
  mode: "suggest",
  organizing: false,
};
async function mount(data: View = initial) {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.navPanels[0].title).toBe("Workstreams");
  return renderSlot(
    app.navPanels[0],
    { subPath: "" },
    {
      rpc: {
        snapshot: () => data,
        cancel: () => ({ ok: true }),
        split: () => ({ ok: true }),
        undo: () => ({ ok: true }),
        organize: () => ({ ok: true }),
        analyze: () => {
          data = {
            ...data,
            analysis: {
              at: 1,
              warnings: [],
              summaries: {},
              items: data.threads.map((t) => ({
                threadId: t.id,
                group: "Vercel Agent for Slack",
                recap: `Recap ${t.id}`,
                updatedAt: t.updatedAt,
                refreshed: true,
                needsYou: t.id === "2",
              })),
            },
          };
          return { ok: true };
        },
      },
    },
  );
}
it("shows all threads under BB projects before analysis without starting a run", async () => {
  const v = await mount();
  await v.findByText("Fix Slack replies");
  // One-thread groups share a section and show their group on the row.
  expect(v.getByRole("heading", { name: "Other groups 2" })).toBeTruthy();
  expect(v.getByText("agents")).toBeTruthy();
  expect(v.getByText("Update API auth")).toBeTruthy();
  expect(v.inspection.rpcCalls.some((c) => c.method === "analyze")).toBe(false);
  v.lifecycle.unmount();
});
it("manual analysis regroups threads across repositories", async () => {
  const v = await mount();
  await v.findByText("Fix Slack replies");
  fireEvent.click(v.getByRole("button", { name: "Analyze threads" }));
  await v.findByRole("heading", { name: "Vercel Agent for Slack 2" });
  expect(v.getByText("Recap 1")).toBeTruthy();
  expect(v.getByText("Recap 2")).toBeTruthy();
  expect(v.getByText("Running")).toBeTruthy();
  expect(v.queryByText("idle")).toBeNull();
  fireEvent.click(v.getByRole("button", { name: /Needs you/, pressed: false }));
  expect(v.queryByText("Recap 1")).toBeNull();
  expect(v.getByText("Recap 2")).toBeTruthy();
  v.lifecycle.unmount();
});
it("opens the existing thread and supports search", async () => {
  const v = await mount();
  await v.findByText("Fix Slack replies");
  fireEvent.click(v.getByRole("button", { name: /Fix Slack replies/ }));
  expect(JSON.stringify(v.inspection.navigateCalls)).toContain('"1"');
  fireEvent.change(v.getByRole("textbox", { name: "Search threads" }), {
    target: { value: "Slack" },
  });
  expect(v.queryByText("Update API auth")).toBeNull();
  v.lifecycle.unmount();
});
it("shows reframed titles without renaming threads and searches original titles", async () => {
  const v = await mount({
    ...initial,
    analysis: {
      at: 1,
      warnings: [],
      summaries: {},
      items: [
        {
          threadId: "1",
          group: "Vercel Agent",
          title: "Slack reply handling",
          recap: "Waiting for review.",
          updatedAt: 1,
          refreshed: true,
        },
      ],
    },
  });
  const card = await v.findByRole("button", { name: /Slack reply handling/ });
  expect(card.getAttribute("title")).toBe("Fix Slack replies");
  fireEvent.change(v.getByRole("textbox", { name: "Search threads" }), {
    target: { value: "Fix Slack replies" },
  });
  expect(v.getByText("Slack reply handling")).toBeTruthy();
  expect(v.queryByText("Update API auth")).toBeNull();
  fireEvent.click(card);
  expect(JSON.stringify(v.inspection.navigateCalls)).toContain('"1"');
  v.lifecycle.unmount();
});
it("disables analysis while it runs and keeps previous threads visible", async () => {
  const v = await mount({
    ...initial,
    progress: { stage: "classifying", completed: 1, total: 2 },
  });
  await v.findByText("Fix Slack replies");
  expect(
    (v.getByRole("button", { name: "Analyze threads" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(v.getByRole("status").textContent).toContain("1/2");
  fireEvent.click(v.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(v.inspection.rpcCalls.some((c) => c.method === "cancel")).toBe(true),
  );
  v.lifecycle.unmount();
});
it("refreshes the inventory after a realtime event", async () => {
  const v = await mount();
  await v.findByText("Fix Slack replies");
  const before = v.inspection.rpcCalls.length;
  await v.behavior.setRealtimeConnectionState("reconnecting");
  await v.behavior.setRealtimeConnectionState("connected");
  await waitFor(() =>
    expect(v.inspection.rpcCalls.length).toBeGreaterThan(before),
  );
  v.lifecycle.unmount();
});
it("offers one-click split for side quests and undo for logged changes", async () => {
  const drift = {
    from: "Lumen",
    to: "Markdown viewer",
    mainlineTitle: "Lumen caching",
    sideTitle: "Viewer themes",
    splitSeq: 30,
    confidence: "medium" as const,
  };
  const v = await mount({
    ...initial,
    analysis: {
      at: 1,
      warnings: [],
      summaries: {},
      items: [
        {
          threadId: "1",
          group: "Markdown viewer",
          recap: "Themes chosen.",
          updatedAt: 1,
          refreshed: true,
          drift,
        },
      ],
    },
    log: [
      {
        id: "e1",
        at: 1,
        action: { kind: "retitle", threadId: "2", title: "API auth" },
        result: "done",
        detail: "",
        undo: { title: "Update API auth" },
        undone: false,
      },
    ],
  });
  fireEvent.click(
    await v.findByRole("button", { name: /Split into “Lumen caching”/ }),
  );
  fireEvent.click(v.getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(
      v.inspection.rpcCalls.filter((c) => ["split", "undo"].includes(c.method)),
    ).toHaveLength(2),
  );
  v.lifecycle.unmount();
});
