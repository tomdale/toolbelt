// @vitest-environment jsdom
import { useContext, useMemo } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { IntakeContext } from "../../src/app/composer/intake.ts";
import { IntakeBanner } from "../../src/app/composer/IntakeBanner.tsx";
import { NewWorkDialog } from "../../src/app/composer/NewWork.tsx";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { RouteDecision } from "../../src/server/router.ts";
import { emptyState } from "./fixtures.ts";
// The SDK composer stub omits draft-view publication.
// This adapter supplies those two host responsibilities around its guarded submit.
const selectionBehavior = vi.hoisted(() => ({
  apply: undefined as
    | undefined
    | ((
        selection: import("@get-bb/plugin-sdk/app").ComposerSelection,
        apply: (
          selection: import("@get-bb/plugin-sdk/app").ComposerSelection,
        ) => Promise<import("@get-bb/plugin-sdk/app").ComposerSelection>,
      ) => Promise<import("@get-bb/plugin-sdk/app").ComposerSelection>),
}));
// BB's submit button stays enabled while a draft routes, so tests read
// readiness from the dialog's intake instead of the button.
const harness = vi.hoisted(() => ({
  intake: undefined as
    undefined | import("../../src/app/composer/intake.ts").Intake,
}));
const submitLifecycle = vi.hoisted(() => ({
  beforeGuard: undefined as
    | undefined
    | ((intake: import("../../src/app/composer/intake.ts").Intake) => void),
  clearDraft: undefined as undefined | (() => void),
  restoreDraft: undefined as undefined | ((draft: string) => void),
  busy: false,
}));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  const Composer = actual.experimental_NewThreadComposer;
  return {
    ...actual,
    useComposer: () => {
      const composer = actual.useComposer();
      return useMemo(() => {
        // Inherit the native reactive getters rather than snapshotting them.
        const adapter = Object.create(composer) as typeof composer;
        adapter.setSelection = (
          selection: import("@get-bb/plugin-sdk/app").ComposerSelection,
        ) =>
          selectionBehavior.apply
            ? selectionBehavior.apply(selection, (next) =>
                composer.setSelection(next),
              )
            : composer.setSelection(selection);
        // The stub has no programmatic submit; drive its button as bb's
        // composer drives its own pipeline.
        adapter.submit = async () => {
          (
            document.querySelector(
              '[data-testid="bb-new-thread-composer-submit"]',
            ) as HTMLButtonElement
          ).click();
        };
        return adapter;
      }, [composer]);
    },
    experimental_NewThreadComposer: function HostComposer(
      props: import("@get-bb/plugin-sdk/app").NewThreadComposerProps,
    ) {
      const intake = useContext(IntakeContext)!;
      harness.intake = intake;
      return (
        <div
          onChangeCapture={(e) => {
            if ((e.target as HTMLElement).tagName === "TEXTAREA")
              intake.observe(
                (e.target as unknown as HTMLTextAreaElement).value,
              );
          }}
          onKeyDown={(e) => {
            if (
              (e.target as HTMLElement).tagName === "TEXTAREA" &&
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              (
                e.currentTarget.querySelector(
                  '[data-testid="bb-new-thread-composer-submit"]',
                ) as HTMLButtonElement
              ).click();
            }
          }}
        >
          <IntakeBanner intake={intake} />
          <Composer
            {...props}
            onSubmit={async (request) => {
              // Like BB: one submit at a time; the draft clears as onSubmit
              // starts (BB's clear renders after onSubmit's synchronous part)
              // and comes back if it rejects.
              if (submitLifecycle.busy) return;
              submitLifecycle.busy = true;
              const draft = (
                document.querySelector(
                  '[data-testid="bb-new-thread-composer-input"]',
                ) as HTMLTextAreaElement
              ).value;
              submitLifecycle.beforeGuard?.(intake);
              const submitted = Promise.resolve(props.onSubmit(request));
              submitLifecycle.clearDraft?.();
              try {
                await submitted;
              } catch {
                submitLifecycle.restoreDraft?.(draft);
              } finally {
                submitLifecycle.busy = false;
              }
            }}
          />
        </div>
      );
    },
  };
});
afterEach(() => {
  cleanup();
  selectionBehavior.apply = undefined;
  submitLifecycle.beforeGuard = undefined;
  submitLifecycle.clearDraft = undefined;
  submitLifecycle.restoreDraft = undefined;
  submitLifecycle.busy = false;
  harness.intake = undefined;
});
const base = {
  id: "d1",
  confidence: "high" as const,
  reason: "",
  subject: null,
  traceId: null,
};
const decision: RouteDecision = {
  ...base,
  outcome: "new-thread",
  sectionId: "sec_a",
  workstream: "Alpha",
  title: "Fix parser",
  placement: {
    projectId: "proj_a",
    environment: { type: "project-default" },
    label: "checkout",
  },
};
function mount(
  route: (args: any) => RouteDecision | Promise<RouteDecision> = () => decision,
  workstreamId: string | null = null,
) {
  const onClose = vi.fn();
  const execute = vi.fn().mockResolvedValue({ threadId: "thr_new" });
  const slot = renderSlot(
    { component: NewWorkDialog },
    {
      open: true,
      onClose,
      workstreamId,
      workstreamName: workstreamId ? "Alpha" : null,
    },
    {
      composer: {
        scope: { kind: "new-thread", projectId: "stale_host_project" },
      },
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", name: "bb" },
            {
              id: "proj_b",
              name: "sideshow",
              sources: [{ hostId: "host_b", isDefault: true }],
            },
          ],
        },
        system: { config: async () => ({ primaryHostId: "host_a" }) },
        environments: {
          list: async () => [],
          listProviders: async () => [
            {
              id: "project-checkout",
              displayName: "Project checkout",
              availability: { status: "available" },
              acceptsEmptyInputs: true,
            },
            {
              id: "git-worktree",
              displayName: "New worktree",
              availability: { status: "available" },
              acceptsEmptyInputs: true,
            },
          ],
        },
        threads: {
          get: async () => ({
            id: "thr_a",
            title: "Parser",
            sectionId: "sec_a",
            projectId: "proj_b",
            environmentId: "env_p",
            environment: { name: "Parser worktree" },
          }),
          defaultExecutionOptions: async () => ({
            providerId: "codex",
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "auto",
          }),
          list: async () => [
            {
              id: "thr_a",
              title: "Spacing fix",
              sectionId: "sec_a",
              projectId: "proj_b",
              environmentId: "env_a",
              environmentName: "Spacing worktree",
            },
          ],
        },
      } as unknown as PluginBrowserBbSdk,
      rpc: {
        state: () => ({
          ...emptyState(),
          workstreams: {
            sec_a: { sectionId: "sec_a", name: "Alpha" },
            sec_b: { sectionId: "sec_b", name: "Beta" },
          },
        }),
        route,
        routeExecute: execute,
      },
    },
  );
  return { slot, onClose, execute };
}
const input = () =>
  screen.getByTestId("bb-new-thread-composer-input") as HTMLTextAreaElement;
const button = () =>
  screen.getByTestId("bb-new-thread-composer-submit") as HTMLButtonElement;
async function type(text = "Fix the parser") {
  fireEvent.change(input(), { target: { value: text } });
}
async function ready() {
  await waitFor(() => expect(harness.intake?.canSubmit()).toBe(true), {
    timeout: 2000,
  });
}
async function choose(field: string, option: string) {
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(`^${field}:`) }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: option }));
}
it("automatic journey submits routed placement and preserves the native request input", async () => {
  const { slot, execute, onClose } = mount();
  await type();
  await ready();
  fireEvent.keyDown(input(), { key: "Enter" });
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(execute.mock.calls[0]![0]).toMatchObject({
    decisionId: "d1",
    prompt: "Fix the parser",
    intent: {},
    execution: {
      input: [{ type: "text", text: "Fix the parser", mentions: [] }],
    },
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(slot.inspection.navigateCalls).toHaveLength(1);
});
it("native composer API draft updates trigger routing through reactive getters", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const { slot } = mount(route);
  await slot.behavior.setComposerText(
    "Changed through the public composer API",
  );
  await waitFor(
    () =>
      expect(route).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Changed through the public composer API",
        }),
      ),
    { timeout: 2000 },
  );
});
it("a submit that isn't ready is rejected, so BB restores its draft", async () => {
  const route = vi.fn().mockResolvedValue(decision);
  const { execute } = mount(route);
  await type();
  await ready();
  submitLifecycle.clearDraft = () =>
    fireEvent.change(input(), { target: { value: "" } });
  submitLifecycle.restoreDraft = (draft) =>
    fireEvent.change(input(), { target: { value: draft } });
  // The draft starts routing again just as it is sent.
  submitLifecycle.beforeGuard = (intake) => intake.retry();
  fireEvent.click(button());
  await screen.findAllByRole("alert");
  await waitFor(() => expect(input().value).toBe("Fix the parser"));
  expect(execute).not.toHaveBeenCalled();
});
it("a ready submit claims the draft before BB clears it and dispatches once", async () => {
  const { execute } = mount();
  await type();
  await ready();
  const order: string[] = [];
  submitLifecycle.beforeGuard = () => order.push("submit");
  submitLifecycle.clearDraft = () => {
    order.push("clear");
    fireEvent.change(input(), { target: { value: "" } });
  };
  execute.mockImplementation(async () => {
    order.push("dispatch");
    return { threadId: "created", sectionId: "sec_a" };
  });
  fireEvent.click(button());
  await waitFor(() => expect(order).toEqual(["submit", "clear", "dispatch"]));
  expect(execute).toHaveBeenCalledTimes(1);
  expect(input().value).toBe("");
});
it("wrong-workstream override is used by route and execute after prompt edits", async () => {
  const { slot, execute } = mount();
  await type();
  await ready();
  await choose("Workstream", "Beta");
  await type("Fix another parser");
  await ready();
  fireEvent.click(button());
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(execute.mock.calls[0]![0].intent.destination).toEqual({
    kind: "workstream",
    id: "sec_b",
  });
  expect(
    slot.inspection.rpcCalls.filter((c) => c.method === "route").at(-1)?.input,
  ).toMatchObject({
    intent: { destination: { kind: "workstream", id: "sec_b" } },
  });
});
const suggested = () =>
  vi.fn().mockResolvedValue({
    ...base,
    id: "d_continue",
    outcome: "continue",
    threadId: "thr_a",
    threadTitle: "Spacing fix",
    sectionId: "sec_a",
    workstream: "Alpha",
    alternative: { ...decision, id: "d_new", title: "" },
  });
it("Enter creates the new thread while a continuation is only suggested", async () => {
  const route = suggested();
  const { execute } = mount(route);
  await type();
  await ready();
  expect(route).toHaveBeenCalledWith(
    expect.objectContaining({ offerNewThread: true }),
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Suggested: continue Spacing fix",
  );
  fireEvent.keyDown(input(), { key: "Enter" });
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(execute.mock.calls[0]![0]).toMatchObject({
    decisionId: "d_new",
    intent: {},
    execution: { projectId: "proj_a" },
  });
});
it.each([
  [
    "⌘⏎",
    () =>
      fireEvent.keyDown(input(), {
        key: "Enter",
        metaKey: true,
        ctrlKey: true,
      }),
  ],
])("%s sends the draft to the suggested thread instead", async (_, press) => {
  const route = suggested();
  const { execute, onClose } = mount(route);
  await type();
  await ready();
  press();
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(execute.mock.calls[0]![0]).toMatchObject({
    decisionId: "d_continue",
    prompt: "Fix the parser",
    intent: {},
    execution: {
      input: [{ type: "text", text: "Fix the parser", mentions: [] }],
    },
  });
  expect(execute.mock.calls[0]![0].execution.projectId).toBeUndefined();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(route).toHaveBeenCalledTimes(1);
});
it("same-project manual environment is used instead of stale host environment", async () => {
  const { execute } = mount();
  await type();
  await ready();
  await choose("Project", "bb");
  await choose("Environment", "New worktree");
  await type("Fix another parser");
  await ready();
  fireEvent.click(button());
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(execute.mock.calls[0]![0].intent.placement).toEqual({
    projectId: "proj_a",
    environment: {
      type: "host",
      hostId: "host_a",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    },
  });
});
it("pending and ambiguous Enter retain the draft, then one submit executes once", async () => {
  let finish!: (d: RouteDecision) => void;
  const { execute } = mount(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await type();
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(input().value).toBe("Fix the parser");
  expect(execute).not.toHaveBeenCalled();
  await waitFor(() => expect(finish).toBeTypeOf("function"), { timeout: 2000 });
  finish({ ...base, outcome: "unsure", candidates: [] });
  await waitFor(() =>
    expect(screen.getAllByText("Pick a destination").length).toBeGreaterThan(0),
  );
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(input().value).toBe("Fix the parser");
  expect(execute).not.toHaveBeenCalled();
  const firstFinish = finish;
  await choose("Destination", "Alpha");
  await waitFor(() => expect(finish).not.toBe(firstFinish));
  finish(decision);
  await ready();
  fireEvent.click(button());
  fireEvent.click(button());
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
});
it("unassigned journey requires project and sends none with latest independent placement", async () => {
  const { execute } = mount((args) => ({
    ...decision,
    sectionId: null,
    workstream: null,
    placement: args.intent.placement?.projectId
      ? { ...decision.placement!, projectId: args.intent.placement.projectId }
      : null,
  }));
  await type();
  await choose("Destination", "No workstream");
  await waitFor(
    () =>
      expect(screen.getAllByText("Pick a project").length).toBeGreaterThan(0),
    { timeout: 2000 },
  );
  expect(harness.intake!.canSubmit()).toBe(false);
  await choose("Project", "sideshow");
  await ready();
  await type("Write a contributor checklist");
  await ready();
  fireEvent.click(button());
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(execute.mock.calls[0]![0].intent).toEqual({
    destination: { kind: "none" },
    placement: { projectId: "proj_b" },
  });
});
it("new-workstream journey sends the edited name", async () => {
  const { execute } = mount(() => ({
    ...base,
    outcome: "new-workstream",
    name: "Offline sync",
    description: "",
    title: "Spike",
    placement: decision.placement,
  }));
  await type();
  await ready();
  fireEvent.change(screen.getByRole("textbox", { name: "Workstream name" }), {
    target: { value: "Sync spike" },
  });
  await ready();
  fireEvent.click(button());
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(execute.mock.calls[0]![0].intent.workstreamName).toBe("Sync spike");
});
it("sidebar + keeps explicit destination, Shift+Enter and composing Enter never submit", async () => {
  const { slot, execute } = mount(undefined, "sec_a");
  await type();
  await ready();
  fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
  expect(execute).not.toHaveBeenCalled();
  expect(
    slot.inspection.rpcCalls.find((c) => c.method === "route")?.input,
  ).toMatchObject({
    intent: { destination: { kind: "workstream", id: "sec_a" } },
  });
});

it("creation Enter waits for deferred native placement acknowledgement without clearing the draft", async () => {
  let finish!: () => void;
  selectionBehavior.apply = (selection, apply) =>
    new Promise((resolve) => {
      finish = async () => resolve(await apply(selection));
    });
  const { execute } = mount();
  await type();
  await waitFor(() => expect(finish).toBeTypeOf("function"), { timeout: 2000 });
  expect(harness.intake!.canSubmit()).toBe(false);
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(execute).not.toHaveBeenCalled();
  expect(input().value).toBe("Fix the parser");
  finish();
  await ready();
  fireEvent.keyDown(input(), { key: "Enter" });
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
});
it("Retry reapplies a rejected native selection when every intent field is manual", async () => {
  const { execute } = mount();
  await type();
  await ready();
  await choose("Action", "New thread");
  await choose("Workstream", "Alpha");
  await choose("Project", "bb");
  await ready();
  const attempts = vi.fn().mockRejectedValueOnce(new Error("host unavailable"));
  selectionBehavior.apply = async (selection, apply) => {
    if (attempts.mock.calls.length === 0) return attempts();
    attempts();
    return apply(selection);
  };
  await choose("Environment", "New worktree");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy(),
  );
  expect(harness.intake!.canSubmit()).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await ready();
  expect(attempts.mock.calls.length).toBeGreaterThan(1);
  fireEvent.click(button());
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
});
it("new worktree uses the selected project's source host rather than global primary host", async () => {
  const { execute } = mount((args) => ({
    ...decision,
    placement: {
      ...decision.placement!,
      projectId: args.intent.placement?.projectId ?? "proj_a",
    },
  }));
  await type();
  await ready();
  await choose("Project", "sideshow");
  await choose("Environment", "New worktree");
  await ready();
  fireEvent.click(button());
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  expect(execute.mock.calls[0]![0].intent.placement.environment.hostId).toBe(
    "host_b",
  );
});
