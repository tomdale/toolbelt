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
import { openDatabase } from "../../src/server/db.ts";
import { CorpusStore } from "../../src/server/corpus.ts";

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
  let seededAlphaId = "";
  const send = vi.fn(async () => {
    if (options.sendFails) throw new Error("send failed");
  });
  world = await fakeWorld({
    send,
    complete: ({ prompt }) => {
      if (prompt.includes("Classify the most specific")) {
        if (answer.outcome === "new-workstream" || answer.name === "Billing") {
          return JSON.stringify({
            subjectId: null,
            proposed: {
              name: String(answer.name ?? "Billing"),
              description: "",
            },
          });
        }
        return JSON.stringify({
          subjectId: seededAlphaId,
          proposed: null,
        });
      }
      return JSON.stringify(
        prompt.includes("Someone is starting new work")
          ? { confidence: "high", reason: "Same effort", code: true, ...answer }
          : { recap: "r", state: "done", subject: null },
      );
    },
  });
  const w = world;
  const alpha = w.addSection("Alpha");
  const beta = w.addSection("Beta");
  const corpus = new CorpusStore(openDatabase(w.bb));
  corpus.seed([
    {
      sectionId: alpha.id,
      name: "Alpha",
      description: "Alpha effort",
      aliases: [],
    },
    {
      sectionId: beta.id,
      name: "Beta",
      description: "Beta effort",
      aliases: [],
    },
  ]);
  seededAlphaId = corpus.list().find((e) => e.name === "Alpha")!.id;
  w.addThread("a1", { sectionId: alpha.id, title: "Alpha task" });
  await w.harness.behavior.callRpc("refresh", null);
  const methods = [
    "prefs",
    "state",
    "catalog",
    "route",
    "routeCancel",
    "sendToThread",
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

it("submits classified automatic identity through host metadata and assigns on server", async () => {
  const { w, slot, dispatch } = await mount({
    outcome: "new-thread",
    subject: "Alpha",
    title: "Fix tabs",
  });
  const prompt = "Fix the parser in Alpha so it handles tabs";
  await act(() => slot.behavior.setComposerText(prompt));
  await screen.findByRole("button", { name: "Product or feature: Alpha" });
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]!.experimental_data).toMatchObject({
    identity: {
      entityId: expect.any(String),
      provenance: "automatic",
    },
  });
  await dispatch(prompt);
  const corpus = new CorpusStore(openDatabase(w.bb));
  const assignment = corpus.assignment("composed");
  expect(assignment.status).toBe("assigned");
  expect(w.spawned).toEqual([]);
  expect(w.sent).toEqual([]);
});

it("submits manual product or feature selection through host metadata", async () => {
  const { w, slot, dispatch } = await mount({
    outcome: "new-thread",
    subject: "Alpha",
    title: "Write docs",
  });
  const prompt = "Write docs for Alpha";
  await act(() => slot.behavior.setComposerText(prompt));
  fireEvent.click(await screen.findByRole("button", { name: /Product or feature:/ }));
  fireEvent.click(await screen.findByText("Beta"));
  await screen.findByRole("button", { name: "Product or feature: Beta" });
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]!.experimental_data).toMatchObject({
    identity: {
      entityId: expect.any(String),
      provenance: "manual",
    },
  });
  await dispatch(prompt);
  const corpus = new CorpusStore(openDatabase(w.bb));
  expect(corpus.assignment("composed").status).toBe("assigned");
  expect(w.spawned).toEqual([]);
});

it("submits a new feature proposal in the UI through host metadata", async () => {
  const { w, slot, dispatch } = await mount({
    outcome: "new-thread",
    title: "Invoice export",
  });
  const prompt = "Add invoice export";
  await act(() => slot.behavior.setComposerText(prompt));
  fireEvent.click(await screen.findByRole("button", { name: /Product or feature:/ }));
  const searchInput = screen.getByPlaceholderText("Find a product or feature");
  fireEvent.change(searchInput, { target: { value: "Billing" } });
  fireEvent.click(await screen.findByRole("option", { name: /New feature proposal “Billing”/ }));
  await screen.findByRole("button", { name: "Product or feature: Billing" });
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]!.experimental_data).toMatchObject({
    identity: {
      proposal: { name: "Billing", description: "" },
      provenance: "manual",
    },
  });
  await dispatch(prompt);
  const corpus = new CorpusStore(openDatabase(w.bb));
  const created = corpus.list().find((e) => e.name === "Billing");
  expect(created).toBeDefined();
  expect(corpus.assignment("composed").entityId).toBe(created!.id);
});

it("retains the complete draft after a server send failure and can retry successfully", async () => {
  const { w, slot, send } = await mount(
    { outcome: "continue", threadId: "a1" },
    { sendFails: true },
  );
  const prompt = "Also handle CRLF in the parser fix @thread:a1";
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

it("submits honest manual unresolved identity through native submission and leaves thread unassigned on server", async () => {
  const { w, slot, dispatch } = await mount({
    outcome: "new-thread",
    workstream: "Alpha",
    title: "Write docs",
  });
  const prompt = "Task without identity";
  await act(() => slot.behavior.setComposerText(prompt));

  const identityButton = await screen.findByRole("button", {
    name: /Product or feature:/,
  });
  fireEvent.click(identityButton);
  const unresolvedOption = await screen.findByRole("option", {
    name: "Unresolved",
  });
  fireEvent.click(unresolvedOption);
  await screen.findByRole("button", {
    name: "Product or feature: Unresolved",
  });

  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]!.experimental_data).toMatchObject({
    identity: {
      entityId: null,
      proposal: null,
      provenance: "manual",
    },
  });
  await dispatch(prompt);
  const corpus = new CorpusStore(openDatabase(w.bb));
  const assignment = corpus.assignment("composed");
  expect(assignment.status).toBe("unresolved");
});
