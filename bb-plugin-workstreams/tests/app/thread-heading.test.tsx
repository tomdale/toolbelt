// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { useBbContext } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { useGoalContext } from "../../src/app/goalContext.ts";
import { emptyState, section, sidebarThread } from "./fixtures.ts";

afterEach(cleanup);

/** The heading's data, as the sticky heading receives it. */
function Heading() {
  const { threadId } = useBbContext();
  const context = useGoalContext(threadId);
  if (!context) return <p>no heading</p>;
  return (
    <div>
      <h2>{context.title}</h2>
      <p aria-label="subtask">{context.subtask ?? "none"}</p>
      <p aria-label="workstream">{context.workstream?.name ?? "unfiled"}</p>
    </div>
  );
}

async function mount(
  thread: PluginSidebarThread,
  server: Record<string, unknown> = {},
) {
  // Loading the app registers its slots, as BB does before rendering any.
  await loadPluginApp(() => import("../../src/app/index.tsx"));
  return renderSlot({ id: "heading", component: Heading } as never, {}, {
    settings: {},
    context: { threadId: thread.id, projectId: "proj_1" },
    rpc: { state: () => ({ ...emptyState(), ...server }) },
    sidebarThreads: {
      status: "ready",
      threads: [thread],
      sections: [section("sec_1", "Lumen")],
      projects: [],
      experimental_archived: null,
    },
  } as never);
}

const analysis = (goal: string) => ({
  recap: "r",
  state: "in_progress",
  needsYou: null,
  subject: null,
  goal,
  drift: null,
  driftSectionId: null,
  revision: 1,
  at: 1,
  model: "m",
});

it("names the thread exactly as BB lists it, whatever the analysis inferred", async () => {
  const slot = await mount(
    sidebarThread("t1", { title: "Fix stale build cache", sectionId: "sec_1" }),
    // An analysis that predates the title, or one the user overrode.
    { analysis: { t1: analysis("Speed up the monorepo build") } },
  );
  expect(await slot.findByRole("heading", { level: 2 })).toHaveProperty(
    "textContent",
    "Fix stale build cache",
  );
  expect(slot.getByLabelText("workstream").textContent).toBe("Lumen");
  slot.lifecycle.unmount();
});

it("shows BB's placeholder for an untitled thread, not a placeholder of its own", async () => {
  const thread = sidebarThread("t1", {
    title: null,
    titleFallback: "fix the cache thing…",
    displayTitle: "fix the cache thing…",
  });
  const slot = await mount(thread, {
    analysis: { t1: analysis("Fix stale build cache") },
  });
  const heading = await slot.findByRole("heading", { level: 2 });
  expect(heading.textContent).toBe("fix the cache thing…");
  expect(slot.queryByText(/Building a clear thread goal/)).toBeNull();
  slot.lifecycle.unmount();
});

it("shows the recap's goal beneath only when it adds to the title", async () => {
  const thread = sidebarThread("t1", { title: "Fix stale build cache" });
  const recap = (goal: string) => ({
    t1: { goal, state: "review", at: 1 },
  });
  const added = await mount(thread, {
    recaps: recap("Cleared the build cache"),
  });
  await added.findByRole("heading", { level: 2 });
  expect(added.getByLabelText("subtask").textContent).toBe(
    "Cleared the build cache",
  );
  added.lifecycle.unmount();

  const same = await mount(thread, { recaps: recap("Fix stale build cache") });
  await same.findByRole("heading", { level: 2 });
  expect(same.getByLabelText("subtask").textContent).toBe("none");
  same.lifecycle.unmount();
});

it("renders nothing for a thread BB doesn't list", async () => {
  await loadPluginApp(() => import("../../src/app/index.tsx"));
  const slot = renderSlot({ id: "heading", component: Heading } as never, {}, {
    settings: {},
    context: { threadId: "gone", projectId: "proj_1" },
    rpc: { state: () => emptyState() },
    sidebarThreads: {
      status: "ready",
      threads: [],
      sections: [],
      projects: [],
      experimental_archived: null,
    },
  } as never);
  expect(slot.getByText("no heading")).toBeTruthy();
  slot.lifecycle.unmount();
});
