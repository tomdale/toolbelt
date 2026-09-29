// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, section, sidebarThread } from "./fixtures.ts";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const sections = [
  section("sec_a", "Alpha"),
  section("sec_b", "Beta"),
  section("sec_z", "Zeta"),
];

async function mount(
  threads = [
    sidebarThread("root", { sectionId: "sec_a", title: "Root task" }),
    sidebarThread("kid", {
      parentThreadId: "root",
      sectionId: "sec_b",
      title: "Kid task",
    }),
    sidebarThread("beta", { sectionId: "sec_b", title: "Beta task" }),
    sidebarThread("loose", { title: "Loose task" }),
    sidebarThread("hidden", { isHidden: true, title: "Hidden helper" }),
  ],
  options: {
    settings?: Record<string, boolean>;
    onNavigate?: () => void;
    analysis?: Record<string, unknown>;
  } = {},
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const list = app.threadLists[0]!;
  return renderSlot(
    list,
    {
      activeThreadId: "beta",
      activeProjectId: null,
      isCompactViewport: false,
      onNavigate: options.onNavigate ?? (() => undefined),
      searchQuery: "",
    },
    {
      sidebarThreads: { status: "ready", threads, sections, projects: [] },
      settings: options.settings ?? {},
      rpc: {
        state: () => ({ ...emptyState(), analysis: options.analysis ?? {} }),
        moveThread: () => ({ entry: null }),
      },
    },
  );
}

const groupRows = (slot: Awaited<ReturnType<typeof mount>>, name: string) =>
  within(slot.getByRole("region", { name }))
    .getAllByRole("link")
    .map((a) => a.getAttribute("aria-label"));

describe("thread list", () => {
  it("groups whole trees by the root's workstream and hides hidden threads", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    expect(groupRows(slot, "Alpha")).toEqual(["Root task", "Kid task"]);
    expect(groupRows(slot, "Beta")).toEqual(["Beta task"]);
    expect(groupRows(slot, "Unsorted")).toEqual(["Loose task"]);
    expect(slot.queryByText("Hidden helper")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps empty workstreams in a collapsed Dormant fold", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const dormant = slot.getByRole("button", { name: /Dormant/ });
    expect(dormant.getAttribute("aria-expanded")).toBe("false");
    expect(slot.queryByRole("region", { name: "Zeta" })).toBeNull();
    fireEvent.click(dormant);
    expect(slot.getByRole("region", { name: "Zeta" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("renders rows as shortcut-target anchors that open threads", async () => {
    let navigated = 0;
    const slot = await mount(undefined, {
      settings: { showRecent: false },
      onNavigate: () => navigated++,
    });
    const link = within(slot.getByRole("region", { name: "Alpha" })).getByRole(
      "link",
      {
        name: "Root task",
      },
    );
    expect(link.getAttribute("data-sidebar-thread-shortcut-target")).toBe("");
    expect(link.getAttribute("data-sidebar-thread-id")).toBe("root");
    expect(link.getAttribute("href")).toBe("/projects/proj_1/threads/root");
    fireEvent.click(link, { metaKey: true });
    expect(slot.inspection.sidebarActionCalls.at(-1)).toMatchObject({
      method: "open",
    });
    expect(navigated).toBe(1);
    slot.lifecycle.unmount();
  });

  it("shows Needs you and Recent as overlays without removing group rows", async () => {
    const slot = await mount([
      sidebarThread("ask", {
        sectionId: "sec_a",
        title: "Asking task",
        hasPendingInteraction: true,
        indicator: "waiting-for-input",
      }),
      sidebarThread("other", { sectionId: "sec_b", title: "Other task" }),
    ]);
    expect(groupRows(slot, "Needs you")).toEqual(["Asking task"]);
    expect(groupRows(slot, "Recent")).toEqual(["Other task"]);
    expect(groupRows(slot, "Alpha")).toEqual(["Asking task"]);
    expect(
      within(slot.getByRole("region", { name: "Alpha" })).getByTitle(
        "1 needs you",
      ),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("persists collapse state per group", async () => {
    const first = await mount(undefined, { settings: { showRecent: false } });
    fireEvent.click(
      within(first.getByRole("region", { name: "Alpha" })).getByRole("button", {
        name: "Alpha",
      }),
    );
    expect(
      within(first.getByRole("region", { name: "Alpha" })).queryAllByRole(
        "link",
      ),
    ).toHaveLength(0);
    first.lifecycle.unmount();
    const second = await mount(undefined, { settings: { showRecent: false } });
    expect(
      within(second.getByRole("region", { name: "Alpha" })).queryAllByRole(
        "link",
      ),
    ).toHaveLength(0);
    second.lifecycle.unmount();
  });

  it("moves a root through the context menu", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const link = within(
      slot.getByRole("region", { name: "Unsorted" }),
    ).getByRole("link", {
      name: "Loose task",
    });
    fireEvent.contextMenu(link.closest("li")!);
    const move = await slot.findByRole("menuitem", {
      name: "Move to workstream",
    });
    fireEvent.keyDown(move, { key: "ArrowRight" });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Beta" }));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some((c) => c.method === "moveThread"),
      ).toBe(true),
    );
    const call = slot.inspection.rpcCalls.find(
      (c) => c.method === "moveThread",
    );
    expect(call?.input).toEqual({ threadId: "loose", sectionId: "sec_b" });
    slot.lifecycle.unmount();
  });

  it("does not offer to move a child on its own", async () => {
    const slot = await mount(undefined, { settings: { showRecent: false } });
    const link = within(slot.getByRole("region", { name: "Alpha" })).getByRole(
      "link",
      {
        name: "Kid task",
      },
    );
    fireEvent.contextMenu(link.closest("li")!);
    const item = await slot.findByRole("menuitem", {
      name: "Moves with its parent",
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    slot.lifecycle.unmount();
  });

  it("lists a current needs-decision result in Needs you, but not a stale one", async () => {
    const at = Date.now();
    const result = (revision: number) => ({
      recap: "Asked whether to ship.",
      state: "needs_decision",
      needsYou: "Ship it?",
      subject: null,
      drift: null,
      driftSectionId: null,
      revision,
      at,
      model: "m",
    });
    const slot = await mount(
      [
        sidebarThread("fresh", { title: "Fresh ask", latestAttentionAt: 100 }),
        sidebarThread("stale", { title: "Stale ask", latestAttentionAt: 200 }),
      ],
      { analysis: { fresh: result(100), stale: result(150) } },
    );
    const band = await slot.findByRole("region", { name: "Needs you" });
    expect(
      within(band)
        .getAllByRole("link")
        .map((a) => a.getAttribute("aria-label")),
    ).toEqual(["Fresh ask"]);
    expect(
      within(slot.getByRole("region", { name: "Unsorted" })).getAllByRole(
        "img",
        { name: "Needs your decision" },
      ),
    ).toHaveLength(1);
    slot.lifecycle.unmount();
  });
});
