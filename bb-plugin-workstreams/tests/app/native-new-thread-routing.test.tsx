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

const identityDecision: RouteDecision = {
  id: "route-alpha",
  traceId: "trace-alpha",
  confidence: "high",
  reason: "Belongs in Alpha",
  subject: "Alpha",
  subjectId: "ent_alpha",
  outcome: "new-thread",
  sectionId: null,
  workstream: null,
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
    component?: typeof RootComposer;
    sendFails?: boolean;
    entities?: { id: string; name: string; description: string; parentId: string | null; aliases: string[] }[];
  } = {},
) {
  const Component = options.component ?? RootComposer;
  const route = vi.fn(async () => decision);
  const routeCancel = vi.fn(async () => ({ canceled: true }));
  const sendToThread = vi.fn(async () => {
    if (options.sendFails) throw new Error("send failed");
    return { threadId: "thread-parser" };
  });
  const draftIdentity = vi.fn(async () => ({ filed: false }));

  const slot = renderSlot(
    {
      component: Component,
    },
    {},
    {
      sdk: {
        projects: {
          list: vi.fn(async () => [{ id: "project-alpha", name: "Alpha", kind: "directory" }]),
        },
        threads: {
          get: vi.fn(async () => ({ id: "thread-parser", projectId: "project-alpha" })),
        },
      } as never,
      composer: {
        scope: { kind: "new-thread", projectId: "project-alpha" },
        text: "",
        selection: { projectId: "project-alpha", environment: { type: "project-default" } },
      } as never,
      rpc: {
        prefs: () => ({
          prefs: {
            newWork: {
              suggestions: true,
              suggestionsModel: { kind: "gateway", model: "model-test" },
            },
          },
        }),
        state: () => ({
          ...emptyState(),
          catalog: {
            entities: options.entities ?? [
              {
                id: "ent_alpha",
                name: "Alpha",
                description: "Alpha product",
                parentId: null,
                aliases: [],
              },
            ],
            groups: {},
            assignments: {},
            revision: 1,
          },
        }),
        catalog: () => ({
          entities: options.entities ?? [
            {
              id: "ent_alpha",
              name: "Alpha",
              description: "Alpha product",
              parentId: null,
              aliases: [],
            },
          ],
          groups: {},
          assignments: {},
          revision: 1,
        }),
        route,
        routeCancel,
        sendToThread,
        draftIdentity,
      },
    },
  );

  return { slot, route, sendToThread, draftIdentity };
}

async function typePrompt(
  slot: ReturnType<typeof mount>["slot"],
  text: string,
) {
  await act(() => slot.behavior.setComposerText(text));
}

it("fills the field with the classified identity and submits it through host submit metadata", async () => {
  const { slot, route } = mount(identityDecision);
  await typePrompt(slot, "Fix the parser in Alpha");
  const field = await screen.findByRole("button", {
    name: "Product or feature: Alpha",
  });
  expect(field.dataset.wsAuto).toBe("true");
  expect(route).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: {
      identity: {
        entityId: "ent_alpha",
        proposal: null,
        provenance: "automatic",
      },
    },
  });
});

it("places the Product or feature picker in the host picker row", async () => {
  mount(identityDecision, { component: RootComposerWithPickerRow });
  const picker = await screen.findByRole("button", {
    name: "Product or feature: Automatic",
  });
  expect(picker).toBeTruthy();
  expect(picker.getAttribute("data-ws-identity-control")).toBe("");
  expect(screen.queryByRole("button", { name: /Workstream:/ })).toBeNull();
});

it("leaves an unsure classification out of the host submit metadata", async () => {
  const unsure: RouteDecision = {
    ...identityDecision,
    id: "route-unsure",
    outcome: "unsure",
    candidates: [],
    subject: null,
    subjectId: null,
  };
  const { slot, route } = mount(unsure);
  await typePrompt(slot, "Something vague");
  await waitFor(() => expect(route).toHaveBeenCalledTimes(1));
  expect(
    screen.getByRole("button", { name: "Product or feature: Automatic" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: null,
  });
});

it("submits manual null identity when selecting Unresolved", async () => {
  const { slot } = mount(identityDecision);
  await typePrompt(slot, "Some unresolvable request");
  fireEvent.click(
    await screen.findByRole("button", { name: "Product or feature: Alpha" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: "Unresolved" }));
  await screen.findByRole("button", { name: "Product or feature: Unresolved" });
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: {
      identity: {
        entityId: null,
        proposal: null,
        provenance: "manual",
      },
    },
  });
});

it("submits proposal identity when proposing a new feature", async () => {
  const proposalDecision: RouteDecision = {
    id: "route-billing",
    traceId: "trace-billing",
    confidence: "high",
    reason: "A new effort",
    subject: "Billing",
    proposal: { name: "Billing", description: "Invoices" },
    outcome: "new-thread",
    sectionId: null,
    workstream: null,
    title: "",
    placement: null,
  };
  const { slot } = mount(proposalDecision);
  await typePrompt(slot, "Add invoice billing");
  await screen.findByRole("button", { name: "Product or feature: Billing" });
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: {
      identity: {
        entityId: null,
        proposal: { name: "Billing", description: "Invoices" },
        provenance: "automatic",
      },
    },
  });
});

it("sends an accepted continuation once without starting another thread", async () => {
  const { slot, route, sendToThread } =
    mount(continuationDecision);
  await typePrompt(slot, "Also handle CRLF");
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Accept suggestion: Send to Parser fix/,
    }),
  );
  await waitFor(() => expect(sendToThread).toHaveBeenCalledTimes(1));
  expect((sendToThread.mock.calls as any)[0]?.[0]).toMatchObject({
    threadId: "thread-parser",
    input: [{ type: "text", text: "Also handle CRLF", mentions: [] }],
    traceId: "trace-continuation",
  });
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
  const { slot, route } = mount(identityDecision, {
    component: DialogComposer,
  });
  await typePrompt(slot, "Fix the parser in Alpha");
  expect(screen.queryByRole("button", { name: /Product or feature:/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Workstream:/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Host submit" }));
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  expect(slot.inspection.composer.submits[0]).toEqual({
    experimental_data: null,
  });
  expect(route).not.toHaveBeenCalled();
});

it("reports the draft's identity so a plain Enter can be filed", async () => {
  const { slot, draftIdentity } = mount(identityDecision);
  await typePrompt(slot, "Fix the parser in Alpha");
  await screen.findByRole("button", { name: "Product or feature: Alpha" });
  await waitFor(() =>
    expect(draftIdentity).toHaveBeenLastCalledWith({
      draftKey: expect.any(String),
      text: "Fix the parser in Alpha",
      identity: { entityId: "ent_alpha", proposal: null, provenance: "automatic" },
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Product or feature: Alpha" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: "Unresolved" }));
  await waitFor(() =>
    expect(draftIdentity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        identity: { entityId: null, proposal: null, provenance: "manual" },
      }),
    ),
  );
});

it("sends to the suggested thread on ⌘⏎, as in New work", async () => {
  const { slot, sendToThread } = mount(continuationDecision);
  await typePrompt(slot, "Also handle CRLF");
  await screen.findByRole("button", {
    name: /Accept suggestion: Send to Parser fix/,
  });
  fireEvent.keyDown(screen.getByRole("button", { name: "Host submit" }), {
    key: "Enter",
    metaKey: true,
    ctrlKey: true,
  });
  await waitFor(() => expect(sendToThread).toHaveBeenCalledTimes(1));
  expect((sendToThread.mock.calls as any)[0]?.[0]).toMatchObject({
    threadId: "thread-parser",
  });
  expect(slot.inspection.composer.submits).toHaveLength(0);
});

it("ignores ⌘⏎ from outside its composer", async () => {
  const { slot, sendToThread } = mount(continuationDecision);
  await typePrompt(slot, "Also handle CRLF");
  await screen.findByRole("button", {
    name: /Accept suggestion: Send to Parser fix/,
  });
  fireEvent.keyDown(document.body, { key: "Enter", metaKey: true, ctrlKey: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sendToThread).not.toHaveBeenCalled();
});

it("shows a failed send once", async () => {
  const { slot } = mount(continuationDecision, { sendFails: true });
  await typePrompt(slot, "Also handle CRLF");
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Accept suggestion: Send to Parser fix/,
    }),
  );
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
  expect(screen.getByRole("alert").textContent).toBe("send failed");
});
