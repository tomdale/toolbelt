// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { resetRouteBanner } from "../../src/app/composer/RouteBanner.tsx";

beforeEach(() => resetRouteBanner());
afterEach(cleanup);

const CHECKOUT = { type: "host", workspace: { type: "unmanaged", path: null } };
const newThread = {
  id: "d1",
  outcome: "new-thread",
  sectionId: "sec_a",
  workstream: "Alpha",
  title: "Fix tabs",
  placement: {
    projectId: "proj_alpha",
    environment: CHECKOUT,
    label: "checkout",
  },
  confidence: "high",
  reason: "Alpha parser work",
  subject: "Alpha",
};
const PROMPT = "Fix the Alpha parser so it handles tab characters";

async function mount(decision: unknown, text = PROMPT) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const custom = app.composerCustomizations.find((c) => c.id === "router")!;
  expect(custom.scopes).toEqual(["new-thread"]);
  const banner = custom.banners![0]!;
  return renderSlot(
    banner,
    {},
    {
      composer: {
        text,
        scope: { kind: "new-thread", projectId: "proj_other" },
      },
      rpc: {
        route: () => decision,
        routeExecute: () => ({ threadId: "thr_target", sectionId: null }),
      },
    },
  );
}

it("stays quiet for short drafts", async () => {
  const slot = await mount(newThread, "fix it");
  await new Promise((r) => setTimeout(r, 700));
  expect(slot.inspection.rpcCalls).toHaveLength(0);
  expect(slot.container.textContent).toBe("");
  slot.lifecycle.unmount();
});

it("previews a new thread, presets the pickers, and starts through the composer", async () => {
  const slot = await mount(newThread);
  await slot.findByText("Alpha", {}, { timeout: 2000 });
  expect(slot.container.textContent).toContain(
    "New thread in Alpha · checkout",
  );
  await waitFor(() =>
    expect(slot.inspection.composer.selections).toEqual([
      { projectId: "proj_alpha", environment: CHECKOUT },
    ]),
  );
  fireEvent.click(slot.getByRole("button", { name: "Start ⏎" }));
  await waitFor(() =>
    expect(slot.inspection.composer.submits).toEqual([
      { experimental_data: { routeId: "d1" } },
    ]),
  );
  slot.lifecycle.unmount();
});

it("sends a continue to its thread and clears the draft", async () => {
  const slot = await mount({
    id: "d2",
    outcome: "continue",
    threadId: "thr_target",
    threadTitle: "Alpha parser",
    workstream: "Alpha",
    confidence: "high",
    reason: "Same task",
    subject: null,
  });
  const send = await slot.findByRole(
    "button",
    { name: "Send there" },
    { timeout: 2000 },
  );
  fireEvent.click(send);
  await waitFor(() =>
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_target" },
    ]),
  );
  expect(slot.inspection.composer.text).toBe("");
  expect(slot.inspection.composer.selections).toEqual([]);
  slot.lifecycle.unmount();
});
