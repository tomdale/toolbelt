// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it } from "vitest";

const subject = "Plan the release";
const tasks = [{ id: 1, subject, status: "pending" as const }];
afterEach(cleanup);

async function mount(clear: (input: unknown) => unknown, snapshot: () => unknown = () => ({ tasks, nextId: 2, pendingClear: null, completedClear: null })) {
  const app = await loadPluginApp(() => import("./app.js"));
  const banner = app.composerCustomizations[0]!.banners![0]!;
  return renderSlot(banner, {}, {
    composer: { scope: { kind: "thread", threadId: "thread-a" } },
    rpc: { snapshot, clear },
  });
}

async function openConfirmation(slot: Awaited<ReturnType<typeof mount>>) {
  await slot.findByText(subject);
  fireEvent.click(slot.getByRole("button", { name: /To-do list:/ }));
  fireEvent.click(slot.getByRole("button", { name: "Clear current Pi Todo list" }));
  expect(slot.getByText(/chat and transcript history will remain/)).toBeTruthy();
}

it("requires explicit confirmation and never clears on cancel", async () => {
  const calls: unknown[] = [];
  const slot = await mount(input => { calls.push(input); return { nextId: 2, boundarySequence: 8 }; });
  await openConfirmation(slot);
  expect(calls).toEqual([]);
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  expect(calls).toEqual([]);
  expect(slot.getByText(subject)).toBeTruthy();
  slot.lifecycle.unmount();
});

it("passes only the composer thread, shows progress and refreshes after the durable reset", async () => {
  const calls: unknown[] = [];
  let resolveClear!: (value: { nextId: number; boundarySequence: number }) => void;
  let cleared = false;
  const slot = await mount(input => {
    calls.push(input);
    return new Promise(resolve => { resolveClear = resolve; });
  }, () => cleared ? { tasks: [], nextId: 19, pendingClear: null, completedClear: (calls[0] as { requestId: string }).requestId } : { tasks, nextId: 2, pendingClear: null, completedClear: null });
  await openConfirmation(slot);
  fireEvent.click(slot.getByRole("button", { name: "Confirm clear" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toEqual({ threadId: "thread-a", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect((slot.getByRole("button", { name: "Checking Pi Todo clear…" }) as HTMLButtonElement).disabled).toBe(true);
  cleared = true;
  resolveClear({ nextId: 19, boundarySequence: 8 });
  await waitFor(() => expect(slot.queryByText(subject)).toBeNull());
  slot.lifecycle.unmount();
});

it("does not show old tasks after an uncertain clear and offers explicit retry", async () => {
  const calls: Array<{ threadId: string; requestId: string }> = [];
  let unresolved = false;
  const slot = await mount(input => { calls.push(input); throw new Error("Pi confirmation timed out"); },
    () => unresolved ? { tasks: [], nextId: 2, pendingClear: calls[0]?.requestId ?? null, completedClear: null }
      : { tasks, nextId: 2, pendingClear: null, completedClear: null });
  await openConfirmation(slot);
  unresolved = true;
  fireEvent.click(slot.getByRole("button", { name: "Confirm clear" }));
  await slot.findByRole("alert");
  expect(slot.queryByText(subject)).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Resume / retry clear" }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toEqual(calls[0]);
  slot.lifecycle.unmount();
});

it("shows pending clear after reload without automatically invoking the provider action", async () => {
  const calls: unknown[] = [];
  const slot = await mount(input => { calls.push(input); return { nextId: 19, boundarySequence: 8 }; },
    () => ({ tasks: [], nextId: 2, pendingClear: "ec48d3bd-e9c1-4271-99cf-9e27aef416ab", completedClear: null }));
  await slot.findByText(/Earlier tasks are hidden/);
  expect(calls).toEqual([]);
  expect(slot.getByRole("button", { name: "Resume / retry clear" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Resume / retry clear" }));
  await waitFor(() => expect(calls).toEqual([{ threadId: "thread-a", requestId: "ec48d3bd-e9c1-4271-99cf-9e27aef416ab" }]));
  slot.lifecycle.unmount();
});
