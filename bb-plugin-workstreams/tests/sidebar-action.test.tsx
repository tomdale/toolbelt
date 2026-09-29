// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const thread = (
  id: string,
  title: string,
  sectionId: string | null = null,
) => ({
  id,
  displayTitle: title,
  parentThreadId: null,
  sectionId,
  projectId: "p",
  status: "idle",
  hasPendingInteraction: false,
  isUnread: false,
  isPinned: false,
  updatedAt: 1,
  latestAttentionAt: 1,
  isArchived: false,
});
const sidebar = {
  analysis: null,
  banners: {},
  owners: {},
  hierarchy: { roles: {}, managers: {} },
};
async function mount(
  threads = [thread("worker", "Work")],
  createManager: () => Promise<{ threadId: string }> = async () => ({
    threadId: "manager",
  }),
) {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(
    app.threadLists[0],
    {
      activeThreadId: null,
      activeProjectId: "p",
      isCompactViewport: false,
      onNavigate: () => {},
      searchQuery: "",
    },
    {
      sidebarThreads: {
        threads: threads as never,
        projects: [
          {
            id: "p",
            name: "Product",
            isPersonal: false,
            href: "/p",
            settingsHref: "/p/settings",
          },
        ],
        sections: [],
      },
      rpc: { sidebar: () => sidebar, createManager },
    },
  );
}
afterEach(cleanup);

it("shows an inline action only for unmanaged groups and invokes RPC on click", async () => {
  const view = await mount();
  const button = await view.findByRole("button", { name: "+ Create manager" });
  expect(view.queryByText("Unmanaged")).toBeNull();
  expect(
    view.inspection.rpcCalls.filter((call) => call.method === "createManager"),
  ).toHaveLength(0);
  fireEvent.click(button);
  await waitFor(() =>
    expect(view.inspection.rpcCalls).toContainEqual({
      method: "createManager",
      input: { groupId: "product:product" },
    }),
  );
  await waitFor(() =>
    expect(
      view.inspection.sidebarActionCalls.some(
        (call) =>
          call.method === "open" && JSON.stringify(call).includes("manager"),
      ),
    ).toBe(true),
  );
  view.lifecycle.unmount();
});

it("does not offer creation when a manager already exists", async () => {
  const view = await mount([
    thread("manager", "Product — manager"),
    thread("worker", "Work"),
  ]);
  await waitFor(() =>
    expect(view.getAllByText("Product — manager").length).toBeGreaterThan(0),
  );
  expect(view.queryByRole("button", { name: "+ Create manager" })).toBeNull();
  expect(
    view.inspection.rpcCalls.filter((call) => call.method === "createManager"),
  ).toHaveLength(0);
  view.lifecycle.unmount();
});

it("reports server errors without navigating", async () => {
  const view = await mount(undefined, async () => {
    throw new Error("Project unavailable");
  });
  fireEvent.click(
    await view.findByRole("button", { name: "+ Create manager" }),
  );
  expect(await view.findByRole("alert")).toHaveProperty(
    "textContent",
    "Project unavailable",
  );
  expect(view.inspection.sidebarActionCalls).toHaveLength(0);
  view.lifecycle.unmount();
});
