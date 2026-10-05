// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { NewWorkDialog } from "../../src/app/composer/NewWork.tsx";
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

const inAlpha: RouteDecision = {
  id: "d_1",
  outcome: "new-thread",
  sectionId: null,
  workstream: null,
  title: "",
  placement: null,
  confidence: "high",
  reason: "Fits Alpha",
  subject: "Alpha",
  subjectId: "ent_alpha",
  traceId: "tr_1",
};

const continueParser: RouteDecision = {
  id: "d_continue",
  outcome: "continue",
  threadId: "thr_p",
  threadTitle: "Parser fix",
  workstream: "Alpha",
  sectionId: null,
  confidence: "high",
  reason: "Continues parser fix",
  subject: null,
  traceId: "tr_continue",
};

function mount(decision: RouteDecision = inAlpha) {
  const onClose = vi.fn();
  const rpc = {
    prefs: vi.fn(() => ({
      prefs: {
        newWork: {
          suggestions: true,
          suggestionsModel: { kind: "gateway", model: "m" },
        },
      },
    })),
    state: vi.fn(() => ({
      ...emptyState(),
      catalog: {
        entities: [
          {
            id: "ent_alpha",
            name: "Alpha",
            description: "Alpha product",
            parentId: null,
            aliases: [],
          },
          {
            id: "ent_beta",
            name: "Beta",
            description: "Beta feature",
            parentId: "ent_alpha",
            aliases: [],
          },
        ],
        groups: {},
        assignments: {},
        revision: 1,
      },
    })),
    catalog: vi.fn(() => ({
      entities: [
        {
          id: "ent_alpha",
          name: "Alpha",
          description: "Alpha product",
          parentId: null,
          aliases: [],
        },
        {
          id: "ent_beta",
          name: "Beta",
          description: "Beta feature",
          parentId: "ent_alpha",
          aliases: [],
        },
      ],
      groups: {},
      assignments: {},
      revision: 1,
    })),
    route: vi.fn(async () => decision),
    routeCancel: vi.fn(async () => ({ canceled: true })),
    startThread: vi.fn(async (_input: unknown) => ({ threadId: "thr_new", sectionId: null })),
    sendToThread: vi.fn(async () => ({ threadId: "thr_p" })),
  };

  const slot = renderSlot(
    { component: NewWorkDialog },
    {
      open: true,
      onClose,
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

const input = () =>
  screen.getByTestId("bb-new-thread-composer-input") as HTMLTextAreaElement;
async function type(slot: ReturnType<typeof mount>["slot"], text: string) {
  fireEvent.change(input(), { target: { value: text } });
  await act(() => slot.behavior.setComposerText(text));
}

describe("NewWork dialog UI", () => {
  it("shows Automatic as the default Product or feature value", async () => {
    mount(inAlpha);
    const field = await screen.findByRole("button", {
      name: "Product or feature: Automatic",
    });
    expect(field.textContent).toContain("Automatic");
    expect(field.textContent).not.toContain("Concerning");
    expect(field.dataset.wsAuto).toBe("true");
    expect(screen.queryByRole("button", { name: /Workstream:/ })).toBeNull();
  });

  it("classifies the draft and updates the Product or feature identity", async () => {
    const { slot, rpc } = mount(inAlpha);
    await type(slot, "Fix the parser in Alpha");
    const field = await screen.findByRole("button", {
      name: "Product or feature: Alpha",
    });
    expect(field.textContent).toContain("Alpha");
    expect(field.dataset.wsAuto).toBe("true");
    expect(rpc.route).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Fix the parser in Alpha",
        suggest: true,
      }),
    );
  });

  it("submits the thread with identity and no destination section", async () => {
    const { slot, rpc, onClose } = mount(inAlpha);
    await type(slot, "Fix the parser in Alpha");
    await screen.findByRole("button", {
      name: "Product or feature: Alpha",
    });

    fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(rpc.startThread).toHaveBeenCalledTimes(1));

    expect(rpc.startThread.mock.calls[0]![0]).toMatchObject({
      identity: {
        entityId: "ent_alpha",
        provenance: "automatic",
      },
      execution: {
        input: [{ type: "text", text: "Fix the parser in Alpha", mentions: [] }],
      },
    });
    expect(rpc.startThread.mock.calls[0]![0]).not.toHaveProperty("sectionId");
    expect(rpc.startThread.mock.calls[0]![0]).not.toHaveProperty("newWorkstream");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(slot.inspection.navigateCalls).toEqual([
      expect.objectContaining({ threadId: "thr_new" }),
    ]);
  });

  it("submits manual unresolved identity when Unresolved is chosen", async () => {
    const { slot, rpc } = mount(inAlpha);
    await type(slot, "Unclear work");
    const field = await screen.findByRole("button", {
      name: "Product or feature: Alpha",
    });

    fireEvent.click(field);
    fireEvent.click(await screen.findByRole("option", { name: "Unresolved" }));
    const manualField = await screen.findByRole("button", {
      name: "Product or feature: Unresolved",
    });
    expect(manualField.textContent).toContain("Unresolved");
    expect(manualField.dataset.wsAuto).toBeUndefined();

    fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(rpc.startThread).toHaveBeenCalledTimes(1));

    expect(rpc.startThread.mock.calls[0]![0]).toMatchObject({
      identity: {
        entityId: null,
        proposal: null,
        provenance: "manual",
      },
    });
  });

  it("shows continuation suggestion and sends to thread when accepted", async () => {
    const { slot, rpc, onClose } = mount(continueParser);
    await type(slot, "Also handle CRLF");

    const acceptBtn = await screen.findByRole("button", {
      name: /Accept suggestion: Send to Parser fix/,
    });
    expect(acceptBtn).toBeTruthy();

    fireEvent.click(acceptBtn);
    await waitFor(() => expect(rpc.sendToThread).toHaveBeenCalledTimes(1));

    expect((rpc.sendToThread.mock.calls as any)[0]![0]).toMatchObject({
      threadId: "thr_p",
      input: [{ type: "text", text: "Also handle CRLF", mentions: [] }],
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
