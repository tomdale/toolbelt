// @vitest-environment jsdom
import { useMemo } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  NewThreadComposerProps,
  PluginBrowserBbSdk,
} from "@get-bb/plugin-sdk/app";
import { NewWorkDialog } from "../../src/app/composer/NewWork.tsx";
import type { RouteDecision } from "../../src/server/router.ts";
import { emptyState } from "./fixtures.ts";

let banners: { id: string; component: React.ComponentType }[] = [];
beforeEach(async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  banners = app.composerCustomizations
    .filter((c) => !c.scopes || c.scopes.includes("new-thread"))
    .flatMap((c) => c.banners ?? []);
});
beforeAll(() => {
  // cmdk and Radix measure and scroll elements jsdom doesn't lay out.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  const StubComposer = actual.experimental_NewThreadComposer;
  const submitButton = () =>
    document.querySelector(
      '[data-testid="bb-new-thread-composer-submit"]',
    ) as HTMLButtonElement;
  return {
    ...actual,
    useComposer: () => {
      const composer = actual.useComposer();
      return useMemo(() => {
        // Inherit the reactive getters; the stub's submit doesn't reach the
        // dialog's onSubmit, so drive its button as BB drives its pipeline.
        const adapter = Object.create(composer) as typeof composer;
        adapter.submit = async () => submitButton().click();
        return adapter;
      }, [composer]);
    },
    // BB's markup around the prompt box: the picker row New work joins.
    experimental_NewThreadComposer: function HostComposer(
      props: NewThreadComposerProps,
    ) {
      return (
        <div data-promptbox-shell="">
          {banners.map(({ id, component: Banner }) => (
            <Banner key={id} />
          ))}
          <form data-promptbox="">
            <StubComposer
              {...props}
              // BB catches a rejected submit and restores the draft.
              onSubmit={(request) =>
                Promise.resolve(props.onSubmit(request)).catch(() => {})
              }
            />
          </form>
          <div>
            <div>
              <button type="button" data-promptbox-project-control="">
                Project
              </button>
            </div>
            <div>Permission</div>
          </div>
        </div>
      );
    },
  };
});

const base = { confidence: "high" as const, reason: "Fits", subject: null };
const placement = {
  projectId: "proj_a",
  environment: {
    type: "host" as const,
    hostId: "host_1",
    workspace: { type: "unmanaged" as const, path: null },
  },
  label: "checkout",
};
const inAlpha: RouteDecision = {
  ...base,
  id: "d_alpha",
  traceId: null,
  outcome: "new-thread",
  sectionId: "sec_a",
  workstream: "Alpha",
  title: "",
  placement,
};
const continueParser: RouteDecision = {
  ...base,
  id: "d_thread",
  traceId: "trace_1",
  outcome: "continue",
  threadId: "thr_p",
  threadTitle: "Parser fix",
  workstream: "Alpha",
  sectionId: "sec_a",
};
const newBilling: RouteDecision = {
  ...base,
  id: "d_new",
  traceId: null,
  outcome: "new-workstream",
  name: "Billing",
  description: "Invoices",
  title: "",
  placement,
};

function mount(
  decision: RouteDecision,
  workstreamId: string | null = null,
  settings: Record<string, boolean> = {},
) {
  const onClose = vi.fn();
  const rpc = {
    prefs: vi.fn(() => ({
      prefs: {
        sidebar: { showForYou: true, showRecent: true, recentLimit: 5 },
        threads: {
          autoTitle: true,
          analysisModel: { kind: "gateway", model: "m" },
          showParentLink: false,
        },
        newWork: {
          homeProjectId: "",
          suggestions: true,
          suggestionsModel: { kind: "gateway", model: "m" },
        },
        organize: { model: { kind: "gateway", model: "m" } },
        advanced: { hostId: "", debug: settings.debug === true },
      },
    })),
    state: vi.fn(() => ({
      ...emptyState(),
      workstreams: {
        sec_a: { sectionId: "sec_a", name: "Alpha" },
        sec_b: { sectionId: "sec_b", name: "Beta" },
      },
    })),
    corpus: vi.fn(() => ({
      entities: [
        {
          id: "inactive-feature",
          name: "Shelves",
          description: "Feature",
          parentId: null,
          aliases: ["Storage"],
        },
      ],
    })),
    corpusSelect: vi.fn((_input: unknown) => ({
      sectionId: "sec_a",
      name: "Alpha",
    })),
    route: vi.fn((_input: unknown) => decision),
    routeCancel: vi.fn((_input: unknown) => ({ canceled: true })),
    startThread: vi.fn((_input: unknown) => ({
      threadId: "thr_new",
      sectionId: null,
    })),
    sendToThread: vi.fn((_input: unknown) => ({ threadId: "thr_p" })),
    trace: vi.fn((_input: unknown) => ({
      trace: {
        id: "trace_1",
        at: 1,
        kind: "route",
        status: "ok",
        label: "Also handle CRLF in that fix",
        model: "test-model",
        durationMs: 900,
        replayOf: null,
        usage: null,
        error: null,
        summary: "continue · Parser fix",
        threads: [],
        provider: "test",
        thinking: "off",
        system: "Return only JSON.",
        prompt:
          "Someone is starting new work. Suggest the single most likely home…",
        input: {
          prompt: "Also handle CRLF in that fix",
          selectedWorkstream: "Beta",
          pickedProjectHosts: null,
          workstreams: [{ name: "Alpha" }, { name: "Beta" }],
          threads: [{ id: "thr_p", title: "Parser fix" }],
        },
        response: '{"outcome":"continue","threadId":"thr_p"}',
        reasoning: "**Same task**\n\nThe draft follows up the parser fix.",
        stopReason: "stop",
        parsed: { outcome: "continue", threadId: "thr_p" },
        outcome: null,
        links: [],
        replays: [],
      },
    })),
    createWorkstream: vi.fn((_input: unknown) => ({
      sectionId: "sec_new",
      entry: { workstreams: [{ id: "sec_new", name: "Billing" }] },
    })),
  };
  const slot = renderSlot(
    { component: NewWorkDialog },
    {
      open: true,
      onClose,
      workstreamId,
      workstreamName: workstreamId ? "Beta" : null,
    },
    {
      settings: {},
      composer: { scope: { kind: "new-thread", projectId: "proj_z" } },
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", name: "bb", kind: "standard" },
            { id: "proj_personal", name: "Personal", kind: "personal" },
          ],
        },
      } as unknown as PluginBrowserBbSdk,
      rpc,
    },
  );
  return { slot, rpc, onClose };
}

it("finds retained inactive identities by alias without losing explicit subject selection", async () => {
  const { rpc } = mount(inAlpha);
  fireEvent.click(
    await screen.findByRole("button", { name: "Workstream: No workstream" }),
  );
  const search = await screen.findByRole("combobox", {
    name: "Search workstreams",
  });
  fireEvent.change(search, { target: { value: "Storage" } });
  fireEvent.click(await screen.findByText("Shelves"));
  await waitFor(() =>
    expect(rpc.corpusSelect).toHaveBeenCalledWith({
      entityId: "inactive-feature",
    }),
  );
  await screen.findByRole("button", { name: "Workstream: Alpha" });
});

const input = () =>
  screen.getByTestId("bb-new-thread-composer-input") as HTMLTextAreaElement;
async function type(slot: ReturnType<typeof mount>["slot"], text: string) {
  fireEvent.change(input(), { target: { value: text } });
  await act(() => slot.behavior.setComposerText(text));
}
const suggestion = () =>
  screen.findByRole("button", { name: / suggestion: / }, { timeout: 2000 });

it("adds a workstream field at the start of BB's picker row", async () => {
  mount(inAlpha);
  const field = await screen.findByRole("button", {
    name: "Workstream: No workstream",
  });
  const project = screen.getByRole("button", { name: "Project" });
  expect(field.closest("[data-ws-workstream-slot]")?.nextElementSibling).toBe(
    project,
  );
});

it("starts the thread the pickers show when the suggestion is ignored", async () => {
  const { slot, rpc, onClose } = mount(inAlpha, "sec_b");
  await type(slot, "Write the release notes");
  await suggestion();
  fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));
  await waitFor(() => expect(rpc.startThread).toHaveBeenCalledTimes(1));
  expect(rpc.startThread.mock.calls[0]![0]).toMatchObject({
    sectionId: "sec_b",
    execution: {
      projectId: "project-test",
      input: [{ type: "text", text: "Write the release notes", mentions: [] }],
    },
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(slot.inspection.navigateCalls).toEqual([
    expect.objectContaining({ threadId: "thr_new" }),
  ]);
});

it("suggests an existing workstream and fills the fields when clicked", async () => {
  const { slot, rpc } = mount(inAlpha);
  await type(slot, "Fix the parser in Alpha");
  const button = await suggestion();
  expect(rpc.route.mock.calls[0]![0]).toMatchObject({
    prompt: "Fix the parser in Alpha",
    suggest: true,
  });
  expect(button.textContent).toContain("Start in Alpha");
  await waitFor(() =>
    expect(button.textContent).toContain("bb · Project checkout"),
  );
  expect(
    screen.getByRole("button", { name: "Apply to the composer" }).textContent,
  ).toContain("Tab");
  expect(
    screen.getByRole("button", { name: "Apply and start the thread" })
      .textContent,
  ).toMatch(/⏎/);
  fireEvent.click(button);
  await screen.findByRole("button", { name: "Workstream: Alpha" });
  expect(slot.inspection.composer.selections).toEqual([
    { projectId: "proj_a", environment: placement.environment },
  ]);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: / suggestion: / })).toBeNull(),
  );
});

it("creates a suggested new workstream before filling the fields", async () => {
  const { slot, rpc } = mount(newBilling);
  await type(slot, "Add CSV export for invoices");
  const button = await suggestion();
  expect(button.textContent).toContain("New workstream Billing");
  fireEvent.click(button);
  await screen.findByRole("button", { name: "Workstream: Billing" });
  expect(rpc.createWorkstream.mock.calls[0]![0]).toEqual({
    name: "Billing",
    description: "Invoices",
  });
});

it("Tab in the editor applies the suggestion without starting", async () => {
  const { slot, rpc, onClose } = mount(inAlpha);
  await type(slot, "Fix the parser in Alpha");
  await suggestion();
  fireEvent.keyDown(input(), { key: "Tab" });
  await screen.findByRole("button", { name: "Workstream: Alpha" });
  expect(slot.inspection.composer.selections).toHaveLength(1);
  expect(rpc.startThread).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it("leaves Tab to the editor when it uses the key itself", async () => {
  const { slot } = mount(inAlpha);
  await type(slot, "Fix the parser in Alpha");
  await suggestion();
  // A mention menu or list indent claims Tab before it bubbles.
  input().addEventListener("keydown", (event) => event.preventDefault(), {
    once: true,
  });
  fireEvent.keyDown(input(), { key: "Tab" });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(slot.inspection.composer.selections).toHaveLength(0);
  screen.getByRole("button", { name: "Workstream: No workstream" });
});

it("⌘⏎ applies a workstream suggestion and starts the thread", async () => {
  const { slot, rpc, onClose } = mount(inAlpha);
  await type(slot, "Fix the parser in Alpha");
  await suggestion();
  fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
  await waitFor(() => expect(rpc.startThread).toHaveBeenCalledTimes(1));
  expect(rpc.startThread.mock.calls[0]![0]).toMatchObject({
    sectionId: "sec_a",
  });
  expect(slot.inspection.composer.selections).toHaveLength(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("⌘⏎ sends the draft to a suggested thread and closes", async () => {
  const { slot, rpc, onClose } = mount(continueParser);
  await type(slot, "Also handle CRLF in that fix");
  const button = await suggestion();
  expect(button.textContent).toContain("Send to Parser fix");
  // A thread has no pickers to fill, so it offers only sending.
  expect(
    screen.queryByRole("button", { name: "Apply to the composer" }),
  ).toBeNull();
  fireEvent.keyDown(input(), { key: "Tab" });
  expect(rpc.sendToThread).not.toHaveBeenCalled();
  fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
  await waitFor(() => expect(rpc.sendToThread).toHaveBeenCalledTimes(1));
  expect(rpc.sendToThread.mock.calls[0]![0]).toEqual({
    threadId: "thr_p",
    input: [
      { type: "text", text: "Also handle CRLF in that fix", mentions: [] },
    ],
    traceId: "trace_1",
  });
  expect(rpc.startThread).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("files the thread in a workstream picked from the field", async () => {
  const { slot, rpc } = mount(inAlpha);
  fireEvent.click(
    await screen.findByRole("button", { name: "Workstream: No workstream" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: /Beta/ }));
  await screen.findByRole("button", { name: "Workstream: Beta" });
  await type(slot, "Write the docs");
  fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));
  await waitFor(() => expect(rpc.startThread).toHaveBeenCalledTimes(1));
  expect(rpc.startThread.mock.calls[0]![0]).toMatchObject({
    sectionId: "sec_b",
  });
});

it("keeps the draft and says why when starting the thread fails", async () => {
  const { slot, rpc, onClose } = mount(inAlpha);
  rpc.startThread.mockImplementation(() => {
    throw new Error("That workstream no longer exists.");
  });
  await type(slot, "Write the docs");
  fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "That workstream no longer exists.",
  );
  expect(onClose).not.toHaveBeenCalled();
});

it("shows no Debug section while Debug mode is off", async () => {
  const { slot } = mount(inAlpha);
  await type(slot, "Fix the parser in Alpha");
  await suggestion();
  expect(screen.queryByText("Debug")).toBeNull();
});

it("shows the result, the model's reason and its inputs in Debug mode", async () => {
  const explained: RouteDecision = {
    ...continueParser,
    explanation: {
      notes: ["The model answered continue."],
      durationMs: 900,
    },
  };
  const { slot, rpc } = mount(explained, "sec_b", { debug: true });
  await type(slot, "Also handle CRLF in that fix");
  await suggestion();
  const debug = screen.getByText("Debug").closest("details")!;
  expect(debug.open).toBe(false);
  expect(debug.querySelector("summary")!.textContent).toContain(
    "Continue “Parser fix” · Shown.",
  );
  expect(debug.textContent).toContain("ReasonFits");
  expect(debug.textContent).toContain("The model answered continue.");
  // The inputs come from the decision's recorded model call.
  await waitFor(() =>
    expect(rpc.trace).toHaveBeenCalledWith({ id: "trace_1" }),
  );
  await within(debug).findByText("Model inputs");
  expect(debug.textContent).toContain("WorkstreamBeta");
  expect(debug.textContent).toContain("Offered2 workstreams · 1 thread");
  expect(debug.textContent).toContain("test-model · 0.9s");
  expect(within(debug).getByLabelText("Prompt").textContent).toContain(
    "Someone is starting new work.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
  await waitFor(() =>
    expect(debug.textContent).toContain(
      "Hidden: you accepted or dismissed it.",
    ),
  );
});

it("tells the router which workstream opened the dialog", async () => {
  const { slot, rpc } = mount(inAlpha, "sec_b");
  await type(slot, "Write the release notes");
  await suggestion();
  expect(rpc.route.mock.calls[0]![0]).toMatchObject({
    prompt: "Write the release notes",
    selectedWorkstreamId: "sec_b",
  });
});
