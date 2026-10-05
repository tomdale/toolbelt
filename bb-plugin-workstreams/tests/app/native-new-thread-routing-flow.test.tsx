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
import { TopicStore } from "../../src/server/topics.ts";

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

async function mount(answer: Record<string, unknown>) {
  let seededAlphaId = "";
  world = await fakeWorld({
    complete: ({ prompt }) =>
      JSON.stringify(
        prompt.includes("You name one new agent thread")
          ? answer.name === "Billing"
            ? {
                goal: "Invoice export",
                subjectId: null,
                proposed: { name: "Billing", description: "" },
              }
            : { goal: "Alpha parser tabs", subjectId: seededAlphaId, proposed: null }
          : { recap: "r", state: "done" },
      ),
  });
  const w = world;
  const alpha = w.addSection("Alpha");
  const beta = w.addSection("Beta");
  const corpus = new TopicStore(openDatabase(w.bb));
  const alphaTopic = corpus.create("Alpha", "Alpha effort");
  corpus.bindGroup(alpha.id, alphaTopic.id);
  corpus.bindGroup(beta.id, corpus.create("Beta", "Beta effort").id);
  seededAlphaId = alphaTopic.id;
  w.addThread("a1", { sectionId: alpha.id, title: "Alpha task" });
  await w.harness.behavior.callRpc("refresh", null);
  const methods = [
    "prefs",
    "state",
    "catalog",
    "preview",
    "previewCancel",
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
        attachments: [],
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
    const thread = w.addThread("composed", {
      createdAt: Date.now(),
      title: null,
    });
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
  return { w, alpha, beta, slot, dispatch, journal };
}

it("submits classified automatic identity through host metadata and assigns on server", async () => {
  const { w, slot, dispatch } = await mount({
    outcome: "new-thread",
    subject: "Alpha",
    title: "Fix tabs",
  });
  const prompt = "Fix the parser in Alpha so it handles tabs";
  await act(() => slot.behavior.setComposerText(prompt));
  await screen.findByRole("button", { name: "Topic: Alpha" });
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]!.experimental_data).toMatchObject({
    identity: {
      entityId: expect.any(String),
      provenance: "automatic",
    },
  });
  await dispatch(prompt);
  const corpus = new TopicStore(openDatabase(w.bb));
  const assignment = corpus.assignment("composed");
  expect(assignment).toMatchObject({ status: "assigned", provenance: "quick" });
  // The composer's preview titles the thread, with no second call.
  await waitFor(() =>
    expect(w.threads.get("composed")?.title).toBe("Alpha parser tabs"),
  );
  expect(w.spawned).toEqual([]);
  expect(w.sent).toEqual([]);
});

it("submits a picked topic through host metadata", async () => {
  const { w, slot, dispatch } = await mount({
    outcome: "new-thread",
    subject: "Alpha",
    title: "Write docs",
  });
  const prompt = "Write docs for Alpha";
  await act(() => slot.behavior.setComposerText(prompt));
  fireEvent.click(await screen.findByRole("button", { name: /Topic:/ }));
  fireEvent.click(await screen.findByText("Beta"));
  await screen.findByRole("button", { name: "Topic: Beta" });
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]!.experimental_data).toMatchObject({
    identity: {
      entityId: expect.any(String),
      provenance: "manual",
    },
  });
  await dispatch(prompt);
  const corpus = new TopicStore(openDatabase(w.bb));
  expect(corpus.assignment("composed").status).toBe("assigned");
  expect(w.spawned).toEqual([]);
});

it("submits a new topic picked in the UI through host metadata", async () => {
  const { w, slot, dispatch } = await mount({
    outcome: "new-thread",
    title: "Invoice export",
  });
  const prompt = "Add invoice export";
  await act(() => slot.behavior.setComposerText(prompt));
  fireEvent.click(await screen.findByRole("button", { name: /Topic:/ }));
  const searchInput = screen.getByPlaceholderText("Find a topic");
  fireEvent.change(searchInput, { target: { value: "Billing" } });
  fireEvent.click(await screen.findByRole("option", { name: /New topic “Billing”/ }));
  await screen.findByRole("button", { name: "Topic: Billing" });
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]!.experimental_data).toMatchObject({
    identity: {
      proposal: { name: "Billing", description: "" },
      provenance: "manual",
    },
  });
  await dispatch(prompt);
  const corpus = new TopicStore(openDatabase(w.bb));
  const created = corpus.list().find((e) => e.name === "Billing");
  expect(created).toBeDefined();
  expect(corpus.assignment("composed").entityId).toBe(created!.id);
});

it("submits a picked No topic through native submission and leaves the thread without one", async () => {
  const { w, slot, dispatch } = await mount({
    outcome: "new-thread",
    workstream: "Alpha",
    title: "Write docs",
  });
  const prompt = "Task without identity";
  await act(() => slot.behavior.setComposerText(prompt));

  const identityButton = await screen.findByRole("button", {
    name: /Topic:/,
  });
  fireEvent.click(identityButton);
  const unresolvedOption = await screen.findByRole("option", {
    name: "No topic",
  });
  fireEvent.click(unresolvedOption);
  await screen.findByRole("button", {
    name: "Topic: No topic",
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
  const corpus = new TopicStore(openDatabase(w.bb));
  const assignment = corpus.assignment("composed");
  expect(assignment.status).toBe("unresolved");
});
