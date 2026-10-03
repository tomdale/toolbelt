// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { NewThreadRouting } from "../../src/app/composer/NewThreadRouting.tsx";
import type { RouteDecision } from "../../src/server/router.ts";
import { emptyState } from "./fixtures.ts";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

const workstreamDecision: RouteDecision = {
  id: "route-alpha",
  traceId: "trace-alpha",
  confidence: "high",
  reason: "Belongs in Alpha",
  subject: null,
  outcome: "new-thread",
  sectionId: "section-alpha",
  workstream: "Alpha",
  title: "",
  placement: null,
};
const continuationDecision: RouteDecision = {
  id: "route-continuation",
  traceId: "trace-continuation",
  confidence: "high",
  reason: "Continues the parser fix",
  subject: null,
  outcome: "continue",
  threadId: "thread-parser",
  threadTitle: "Parser fix",
  workstream: "Alpha",
  sectionId: "section-alpha",
};

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

function RootComposerWithPickerRow() {
  return (
    <main data-app-composer-role="primary">
      <div data-promptbox-shell="">
        <NewThreadRouting />
        <form data-promptbox="" />
        <div>
          <div>
            <button type="button" data-promptbox-project-control="">
              Project
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

type Attachment = {
  name: string;
  path: string;
  sizeBytes: number;
  type: "localImage" | "localFile";
  mimeType?: string;
};

function DialogComposer() {
  const composer = useComposer();
  return (
    <div role="dialog">
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
    </div>
  );
}

function mount(
  decision: RouteDecision,
  options: {
    sendFails?: boolean;
    createWorkstreamFails?: boolean;
    workstreams?: Record<string, unknown>;
    targetProjectId?: string;
    attachments?: Partial<Attachment>[];
    component?: React.ComponentType;
  } = {},
) {
  const route = vi.fn(async () => decision);
  const sendToThread = vi.fn(async (_input: unknown) => {
    if (options.sendFails) throw new Error("send failed");
    return { threadId: "thread-parser" };
  });
  const startThread = vi.fn(async (_input: unknown) => ({
    threadId: "thread-created",
  }));
  const createWorkstream = vi.fn(async () => {
    if (options.createWorkstreamFails)
      throw new Error("create workstream failed");
    return {
      sectionId: "section-created",
      entry: { workstreams: [{ id: "section-created", name: "Billing" }] },
    };
  });
  const copyAttachments = vi.fn(async () => {});
  const slot = renderSlot(
    {
      component: options.component ?? RootComposer,
    },
    {},
    {
      composer: {
        text: "",
        attachments: (options.attachments ?? []).map((a, i) => ({
          name: a.name ?? `file-${i}.txt`,
          path: a.path ?? `/workspace/file-${i}.txt`,
          sizeBytes: a.sizeBytes ?? 100,
          type: a.type ?? "localFile",
          ...(a.mimeType ? { mimeType: a.mimeType } : {}),
        })),
        scope: { kind: "new-thread", projectId: "project-alpha" },
        selection: { projectId: "project-alpha" },
      },
      sdk: {
        projects: {
          list: async () => [],
          attachments: { copy: copyAttachments },
        },
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            projectId: options.targetProjectId ?? "project-alpha",
            archivedAt: null,
          }),
        },
      } as never,
      rpc: {
        prefs: async () => ({ prefs: {} }),
        state: async () => ({
          ...emptyState(),
          workstreams: options.workstreams ?? {},
          order: { workstreams: [], threads: {}, prioritized: [] },
        }),
        route,
        routeCancel: async () => ({ canceled: true }),
        startThread,
        sendToThread,
        createWorkstream,
      } as never,
    },
  );
  return {
    slot,
    route,
    sendToThread,
    startThread,
    createWorkstream,
    copyAttachments,
  };
}

async function typePrompt(
  slot: ReturnType<typeof mount>["slot"],
  text: string,
) {
  await act(() => slot.behavior.setComposerText(text));
}

it("fills the field with the classified home and files it through host submit metadata", async () => {
  const { slot, route, startThread } = mount(workstreamDecision);
  await typePrompt(slot, "Fix the parser in Alpha");
  const field = await screen.findByRole("button", {
    name: "Workstream: Alpha",
  });
  expect(field.dataset.wsAuto).toBe("true");
  expect(route).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: { routeId: "route-alpha", sectionId: "section-alpha" },
  });
  expect(startThread).not.toHaveBeenCalled();
  expect(
    slot.inspection.rpcCalls.filter((call) => call.method === "route"),
  ).toHaveLength(1);
});

it("places the Workstream picker before the project picker in the host picker row", async () => {
  mount(workstreamDecision, { component: RootComposerWithPickerRow });
  const picker = await screen.findByRole("button", {
    name: "Workstream: Automatic",
  });
  const anchor = picker.closest("[data-ws-workstream-slot]");
  expect(anchor).toBeTruthy();
  expect(
    anchor!.compareDocumentPosition(
      document.querySelector("[data-promptbox-project-control]")!,
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    document
      .querySelector("[data-promptbox]")!
      .compareDocumentPosition(anchor!) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("draws the picker with the plugin's declared icons, never BB's fallback", async () => {
  mount(workstreamDecision);
  fireEvent.click(
    await screen.findByRole("button", { name: "Workstream: Automatic" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: "No workstream" }));
  const picker = await screen.findByRole("button", {
    name: "Workstream: No workstream",
  });
  expect(picker.dataset.wsAuto).toBeUndefined();
  // BB draws an undeclared icon name as a lightning bolt.
  expect(
    picker.querySelector('[data-icon="workstreams/workstream-none"]'),
  ).toBeTruthy();
  expect(picker.querySelector('[data-icon="CircleDashed"]')).toBeNull();
});

it("shows each workstream's description under its name and searches it", async () => {
  mount(workstreamDecision, {
    workstreams: {
      alpha: {
        sectionId: "section-alpha",
        name: "Alpha",
        description: "Adaptive grouping for threads",
      },
      beta: { sectionId: "section-beta", name: "Beta", description: null },
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Workstream: Automatic" }),
  );
  expect(await screen.findByText("Adaptive grouping for threads")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText(/Find or create/), {
    target: { value: "adaptive" },
  });
  expect(screen.getByText("Alpha")).toBeTruthy();
  expect(screen.queryByText("Beta")).toBeNull();
});

it("leaves a classification that names no home out of the host submit metadata", async () => {
  const unsure = {
    ...workstreamDecision,
    id: "route-unsure",
    outcome: "unsure" as const,
    candidates: [],
    sectionId: null,
    workstream: null,
  };
  const { slot, route, startThread } = mount(unsure);
  await typePrompt(slot, "Something vague");
  await waitFor(() => expect(route).toHaveBeenCalledTimes(1));
  expect(
    screen.getByRole("button", { name: "Workstream: Automatic" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: null,
  });
  expect(startThread).not.toHaveBeenCalled();
});

it("creates a proposed workstream when submitting, and files it through host metadata", async () => {
  const newWorkstream: RouteDecision = {
    id: "route-billing",
    traceId: "trace-billing",
    confidence: "high",
    reason: "A new effort",
    subject: null,
    outcome: "new-workstream",
    name: "Billing",
    description: "Invoices",
    title: "Invoice export",
    placement: null,
  };
  const { slot, startThread, createWorkstream } = mount(newWorkstream);
  await typePrompt(slot, "Add invoice export");
  const field = await screen.findByRole("button", {
    name: "Workstream: Billing",
  });
  expect(field.dataset.wsAuto).toBe("true");
  expect(createWorkstream).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(createWorkstream).toHaveBeenCalledTimes(1);
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: {
      routeId: "route-billing",
      sectionId: "section-created",
    },
  });
  expect(startThread).not.toHaveBeenCalled();
});

it("files an explicitly selected workstream through ordinary host form submit", async () => {
  const { slot, startThread } = mount(workstreamDecision, {
    workstreams: { beta: { sectionId: "section-beta", name: "Beta" } },
  });
  await typePrompt(slot, "Write docs");
  await screen.findByRole("button", { name: "Workstream: Automatic" });
  fireEvent.click(
    screen.getByRole("button", { name: "Workstream: Automatic" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: "Beta" }));
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: { sectionId: "section-beta" },
  });
  expect(startThread).not.toHaveBeenCalled();
});

it("sends an accepted continuation once without starting another thread", async () => {
  const { slot, route, sendToThread, startThread } =
    mount(continuationDecision);
  await typePrompt(slot, "Also handle CRLF");
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Accept suggestion: Send to Parser fix/,
    }),
  );
  await waitFor(() => expect(sendToThread).toHaveBeenCalledTimes(1));
  expect(sendToThread.mock.calls[0]?.[0]).toMatchObject({
    threadId: "thread-parser",
    input: [{ type: "text", text: "Also handle CRLF", mentions: [] }],
    traceId: "trace-continuation",
  });
  expect(startThread).not.toHaveBeenCalled();
  expect(slot.inspection.composer.submits).toHaveLength(0);
  expect(route).toHaveBeenCalledTimes(1);
});

it("retains the composer draft when sending a continuation fails", async () => {
  const { slot } = mount(continuationDecision, { sendFails: true });
  await typePrompt(slot, "Also handle CRLF");
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Accept suggestion: Send to Parser fix/,
    }),
  );
  await waitFor(() =>
    expect(screen.getAllByText("send failed").length).toBeGreaterThan(0),
  );
  expect(slot.inspection.composer.draft.text).toBe("Also handle CRLF");
  expect(slot.inspection.navigateCalls).toHaveLength(0);
});

it("does not render routing controls or intercept submits when inside a dialog", async () => {
  const { slot, route } = mount(workstreamDecision, {
    component: DialogComposer,
  });
  await typePrompt(slot, "Fix the parser in Alpha");
  expect(
    screen.queryByRole("button", { name: "Apply and start the thread" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: /Workstream:/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: null,
  });
  expect(route).not.toHaveBeenCalled();
});

it("submits sectionId: null metadata when manually clearing workstream back to No workstream (Bug 1)", async () => {
  const { slot } = mount(workstreamDecision, {
    workstreams: { beta: { sectionId: "section-beta", name: "Beta" } },
  });
  await typePrompt(slot, "Write docs");
  await screen.findByRole("button", { name: "Workstream: Automatic" });
  fireEvent.click(
    screen.getByRole("button", { name: "Workstream: Automatic" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: "Beta" }));
  expect(
    await screen.findByRole("button", { name: "Workstream: Beta" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Workstream: Beta" }));
  fireEvent.click(await screen.findByRole("option", { name: "No workstream" }));
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: {
      sectionId: null,
    },
  });
});

it("retains the draft and reports an alert when creating a proposal on submit fails", async () => {
  const newWorkstream: RouteDecision = {
    id: "route-billing",
    traceId: "trace-billing",
    confidence: "high",
    reason: "A new effort",
    subject: null,
    outcome: "new-workstream",
    name: "Billing",
    description: "Invoices",
    title: "Invoice export",
    placement: null,
  };
  const { slot } = mount(newWorkstream, { createWorkstreamFails: true });
  await typePrompt(slot, "Add invoice export");
  await screen.findByRole("button", { name: "Workstream: Billing" });
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() =>
    expect(
      screen.getAllByText("create workstream failed").length,
    ).toBeGreaterThan(0),
  );
  expect(slot.inspection.composer.submits).toHaveLength(0);
  expect(slot.inspection.composer.draft.text).toBe("Add invoice export");
});

it("copies draft attachments across projects when sending an accepted continuation", async () => {
  const { slot, sendToThread, copyAttachments } = mount(continuationDecision, {
    targetProjectId: "project-beta",
    attachments: [{ path: "/workspace/notes.txt" }],
  });
  await typePrompt(slot, "Also handle CRLF");
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Accept suggestion: Send to Parser fix/,
    }),
  );
  await waitFor(() => expect(sendToThread).toHaveBeenCalledTimes(1));
  expect(copyAttachments).toHaveBeenCalledWith({
    projectId: "project-beta",
    sourceProjectId: "project-alpha",
    paths: ["/workspace/notes.txt"],
  });
  expect(slot.inspection.composer.draft.text).toBe("");
  expect(slot.inspection.composer.draft.attachments).toEqual([]);
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "toThread", threadId: "thread-parser" },
  ]);
});

it("dismisses a suggestion behind a pinned field and submits with null metadata", async () => {
  const { slot } = mount(workstreamDecision);
  await typePrompt(slot, "Fix the parser in Alpha");
  // Pin the field on No workstream: the suggestion keeps its row there.
  fireEvent.click(
    await screen.findByRole("button", { name: "Workstream: Automatic" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: "No workstream" }));
  await screen.findByRole("button", { name: "Apply and start the thread" });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Apply and start the thread" }),
    ).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: {
      sectionId: null,
    },
  });
});
