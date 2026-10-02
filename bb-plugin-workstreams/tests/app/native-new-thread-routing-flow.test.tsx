// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { NewThreadRouting } from "../../src/app/composer/NewThreadRouting.tsx";
import { fakeWorld } from "../server/fake-bb.ts";

let world: Awaited<ReturnType<typeof fakeWorld>> | null = null;
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(async () => {
  cleanup();
  await world?.harness.lifecycle.dispose();
  world = null;
});

function RootComposer() {
  const composer = useComposer();
  return (
    <main data-app-composer-role="primary">
      <NewThreadRouting />
      <form
        data-promptbox=""
        onSubmit={(event) => {
          event.preventDefault();
          void composer.submit({ experimental_data: null });
        }}
      >
        <button type="submit">Host submit</button>
      </form>
    </main>
  );
}

async function mount(
  answer: Record<string, unknown>,
  options: { sendFails?: boolean } = {},
) {
  const send = vi.fn(async () => {
    if (options.sendFails) throw new Error("send failed");
  });
  world = await fakeWorld({
    send,
    complete: ({ prompt }) =>
      JSON.stringify(
        prompt.includes("Someone is starting new work")
          ? { confidence: "high", reason: "Same effort", code: true, ...answer }
          : { recap: "r", state: "done", subject: null },
      ),
  });
  const w = world;
  const alpha = w.addSection("Alpha");
  const beta = w.addSection("Beta");
  w.addThread("a1", { sectionId: alpha.id, title: "Alpha task" });
  await w.harness.behavior.callRpc("refresh", null);
  const methods = [
    "prefs",
    "state",
    "route",
    "routeCancel",
    "createWorkstream",
    "sendToThread",
    "startThread",
  ];
  const rpc = Object.fromEntries(
    methods.map((method) => [
      method,
      (input: unknown) => w.harness.behavior.callRpc(method, input),
    ]),
  );
  const slot = renderSlot(
    { component: RootComposer },
    {},
    {
      composer: {
        text: "",
        attachments: options.sendFails
          ? [
              {
                name: "notes.txt",
                path: "/workspace/notes.txt",
                sizeBytes: 100,
                type: "localFile",
              },
            ]
          : [],
        scope: { kind: "new-thread", projectId: "proj_1" },
        selection: { projectId: "proj_1" },
      },
      sdk: {
        projects: { list: (input: never) => w.bb.sdk.projects.list(input) },
        threads: { get: (input: never) => w.bb.sdk.threads.get(input) },
      } as never,
      rpc: rpc as never,
    },
  );
  const dispatch = async (prompt: string, repeat = false) => {
    expect(slot.inspection.composer.submits).toHaveLength(1);
    const submission = slot.inspection.composer.submits[0]!;
    const thread = w.addThread("composed", { createdAt: Date.now() });
    const context = makeMessageDispatchHookContext({
      thread,
      input: { text: prompt },
      origin: "app",
      experimental_submission: {
        pluginId: "workstreams",
        data: submission.experimental_data ?? null,
      },
    });
    const hook = w.harness.registrations.hooks["message.dispatch"]!;
    vi.useFakeTimers();
    try {
      expect(await hook(context)).toEqual({ action: "proceed" });
      if (repeat) expect(await hook(context)).toEqual({ action: "proceed" });
      await act(() => vi.advanceTimersByTimeAsync(0));
    } finally {
      vi.useRealTimers();
    }
  };
  const journal = async () => {
    const result = (await w.harness.behavior.callRpc("journal", null)) as {
      entries: { action: string; source: string; threads: { id: string }[] }[];
    };
    return result.entries.filter((entry) =>
      entry.threads.some((thread) => thread.id === "composed"),
    );
  };
  return { w, alpha, beta, slot, dispatch, journal, send };
}

it("keeps ordinary host submission unfiled despite a visible matching suggestion", async () => {
  const { w, slot, dispatch, journal } = await mount({
    outcome: "new-thread",
    workstream: "Alpha",
    title: "Fix tabs",
  });
  const prompt = "Fix the parser in Alpha so it handles tabs";
  await act(() => slot.behavior.setComposerText(prompt));
  await screen.findByRole("button", { name: "Apply and start the thread" });
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: null,
  });
  await dispatch(prompt);
  expect(w.threads.get("composed")?.sectionId).toBeNull();
  expect(await journal()).toEqual([]);
  expect(w.spawned).toEqual([]);
  expect(w.sent).toEqual([]);
});

it("files a manual Workstream selection through host metadata and the server dispatch hook", async () => {
  const { w, beta, slot, dispatch, journal } = await mount({
    outcome: "new-thread",
    workstream: "Alpha",
    title: "Write docs",
  });
  const prompt = "Write docs for Alpha";
  await act(() => slot.behavior.setComposerText(prompt));
  await screen.findByRole("button", { name: "Apply and start the thread" });
  fireEvent.click(
    screen.getByRole("button", { name: "Workstream: No workstream" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: "Beta" }));
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: { sectionId: beta.id },
  });
  await dispatch(prompt);
  expect(w.threads.get("composed")?.sectionId).toBe(beta.id);
  expect(await journal()).toEqual([
    expect.objectContaining({ action: "move", source: "user" }),
  ]);
  expect(w.spawned).toEqual([]);
});

it("accepts a new workstream in the UI and files exactly once even when dispatch is repeated", async () => {
  const { w, slot, dispatch, journal } = await mount({
    outcome: "new-workstream",
    name: "Billing",
    description: "Invoices",
    title: "Invoice export",
  });
  const prompt = "Add invoice export to a new Billing service";
  await act(() => slot.behavior.setComposerText(prompt));
  fireEvent.click(
    await screen.findByRole("button", { name: "Apply and start the thread" }),
  );
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  const billing = w.sections.find((section) => section.name === "Billing")!;
  expect(billing).toBeDefined();
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: { routeId: expect.any(String), sectionId: billing.id },
  });
  await dispatch(prompt, true);
  expect(
    w.sections.filter((section) => section.name === "Billing"),
  ).toHaveLength(1);
  expect(w.threads.get("composed")?.sectionId).toBe(billing.id);
  expect(await journal()).toEqual([
    expect.objectContaining({ action: "move", source: "router" }),
  ]);
  expect(
    slot.inspection.rpcCalls.filter(
      (call) => call.method === "createWorkstream",
    ),
  ).toHaveLength(1);
  expect(w.spawned).toEqual([]);
});

it("retains the complete draft after a server send failure and can retry successfully", async () => {
  const { w, slot, send } = await mount(
    { outcome: "continue", threadId: "a1" },
    { sendFails: true },
  );
  const prompt = "Also handle CRLF in the parser fix";
  await act(() => slot.behavior.setComposerText(prompt));
  const draft = structuredClone(slot.inspection.composer.draft);
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Accept suggestion: Send to Alpha task/,
    }),
  );
  await waitFor(() =>
    expect(screen.getAllByText("send failed").length).toBeGreaterThan(0),
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(slot.inspection.composer.draft).toEqual(draft);
  expect(slot.inspection.composer.submits).toEqual([]);
  expect(slot.inspection.navigateCalls).toEqual([]);
  expect(w.sent).toEqual([]);
  expect(w.spawned).toEqual([]);
  const continuationEntries = async () => {
    const result = (await w.harness.behavior.callRpc("journal", null)) as {
      entries: { action: string; threads: { id: string }[] }[];
    };
    return result.entries.filter(
      (entry) =>
        entry.action === "route" &&
        entry.threads.some((thread) => thread.id === "a1"),
    );
  };
  expect(await continuationEntries()).toEqual([]);
  send.mockResolvedValue(undefined);
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Accept suggestion: Send to Alpha task/,
    }),
  );
  await waitFor(() =>
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "a1" },
    ]),
  );
  expect(w.sent).toEqual([
    {
      threadId: "a1",
      mode: "queue-if-active",
      input: [
        { type: "text", text: prompt, mentions: [] },
        {
          type: "localFile",
          path: "/workspace/notes.txt",
          name: "notes.txt",
          sizeBytes: 100,
        },
      ],
    },
  ]);
  expect(slot.inspection.composer.draft.text).toBe("");
  expect(slot.inspection.composer.draft.attachments).toEqual([]);
  expect(send).toHaveBeenCalledTimes(2);
  expect(await continuationEntries()).toHaveLength(1);
});
