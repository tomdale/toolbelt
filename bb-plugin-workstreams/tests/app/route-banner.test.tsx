// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { resetRouteBanner } from "../../src/app/composer/RouteBanner.tsx";
import { DEBOUNCE_MS, SHORT_PAUSE_MS } from "../../src/app/composer/timing.ts";

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

async function mount(
  decision: unknown,
  text = PROMPT,
  route: () => unknown = () => decision,
) {
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
        route,
        routeCancel: () => ({ canceled: true }),
        routeExecute: () => ({ threadId: "thr_target", sectionId: null }),
      },
    },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("routes a short draft only once typing pauses, and shows only its decision", async () => {
  const slot = await mount(newThread, "fix it");
  await sleep(SHORT_PAUSE_MS - 200);
  expect(slot.inspection.rpcCalls).toHaveLength(0);
  expect(slot.container.textContent).toBe("");
  await slot.findByText("Alpha", {}, { timeout: 2000 });
  expect(slot.inspection.rpcCalls.map((c) => c.method)).toEqual(["route"]);
  slot.lifecycle.unmount();
});

it("cancels the routing call in flight as soon as the draft changes", async () => {
  const slot = await mount(newThread, PROMPT, () => new Promise(() => {}));
  await waitFor(
    () =>
      expect(slot.inspection.rpcCalls.map((c) => c.method)).toEqual(["route"]),
    { timeout: DEBOUNCE_MS + 1000 },
  );
  await slot.behavior.setComposerText(`${PROMPT} and spaces`);
  expect(slot.inspection.rpcCalls.map((c) => c.method)).toEqual([
    "route",
    "routeCancel",
  ]);
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.map((c) => c.method)).toEqual([
      "route",
      "routeCancel",
      "route",
    ]),
  );
  const [first, , second] = slot.inspection.rpcCalls;
  expect(second!.input).toMatchObject({ prompt: `${PROMPT} and spaces` });
  // Both calls name the same draft, so the server can abort the first.
  expect((second!.input as { draftKey: string }).draftKey).toBe(
    (first!.input as { draftKey: string }).draftKey,
  );
  slot.lifecycle.unmount();
});

it("previews a new thread, presets the pickers, and starts through the composer", async () => {
  const slot = await mount(newThread);
  await slot.findByText("Alpha", {}, { timeout: 2000 });
  expect(slot.container.textContent).toContain("New thread in Alpha");
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
    traceId: null,
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

it("presets the environment even when the project already matches", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const banner = app.composerCustomizations.find((c) => c.id === "router")!
    .banners![0]!;
  const slot = renderSlot(
    banner,
    {},
    {
      composer: {
        text: PROMPT,
        scope: { kind: "new-thread", projectId: "proj_alpha" },
      },
      rpc: { route: () => newThread },
    },
  );
  await waitFor(
    () =>
      expect(slot.inspection.composer.selections).toEqual([
        { projectId: "proj_alpha", environment: CHECKOUT },
      ]),
    { timeout: 2000 },
  );
  slot.lifecycle.unmount();
});

it("disables actions while the draft differs from what was routed", async () => {
  const slot = await mount(newThread);
  const start = await slot.findByRole(
    "button",
    { name: "Start ⏎" },
    { timeout: 2000 },
  );
  expect((start as HTMLButtonElement).disabled).toBe(false);
  await slot.behavior.setComposerText(`${PROMPT} and spaces`);
  expect(
    (slot.getByRole("button", { name: "Start ⏎" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  slot.lifecycle.unmount();
});

it("routes again with the user's project when they override the preset", async () => {
  const slot = await mount(newThread);
  await waitFor(
    () => expect(slot.inspection.composer.selections).toHaveLength(1),
    {
      timeout: 2000,
    },
  );
  await slot.behavior.setComposerScope({
    kind: "new-thread",
    projectId: "proj_alpha",
  });
  await slot.behavior.setComposerScope({
    kind: "new-thread",
    projectId: "proj_mine",
  });
  await waitFor(
    () =>
      expect(
        slot.inspection.rpcCalls.filter((c) => c.method === "route").at(-1)
          ?.input,
      ).toMatchObject({ pickedProjectId: "proj_mine" }),
    { timeout: 2000 },
  );
  slot.lifecycle.unmount();
});
