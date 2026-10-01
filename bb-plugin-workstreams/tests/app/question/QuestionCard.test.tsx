// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  InteractionPayload,
  InteractionResponse,
} from "../../../src/server/questions/contracts.ts";

const app = await loadPluginApp(() => import("../../../src/app/index.tsx"));

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(cleanup);

const singleSelect: InteractionPayload = {
  questions: [
    {
      id: "q0",
      prompt: "Which database should we use?",
      shortLabel: "Database",
      multiSelect: false,
      allowFreeText: true,
      options: [
        {
          value: "q0o0",
          label: "Postgres",
          description: "Relational, needs a server.",
          preview: "CREATE TABLE users (id uuid primary key);",
        },
        {
          value: "q0o1",
          label: "SQLite",
          description: "Embedded, zero setup.",
        },
      ],
    },
  ],
};

function render(
  payload: InteractionPayload,
  handlers: {
    submit?: (value: unknown) => Promise<void>;
    cancel?: () => Promise<void>;
  } = {},
) {
  return renderSlot(app.pendingInteractions[0]!, {
    interaction: {
      id: "pint_test",
      threadId: "thr_test",
      title: "Database",
      payload: payload as never,
      createdAt: 0,
      expiresAt: null,
    },
    submit: handlers.submit ?? (async () => undefined),
    cancel: handlers.cancel ?? (async () => undefined),
  });
}

function getButtonByText(
  slot: ReturnType<typeof render>,
  text: string,
): HTMLButtonElement {
  const button = slot.getByText(text).closest("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`${text} is not rendered inside a button`);
  }
  return button;
}

describe("question interaction adapter", () => {
  it("submits the selected option value", () => {
    const submit = vi.fn(async (_value: unknown) => undefined);
    const slot = render(singleSelect, { submit });

    expect(slot.getAllByText("Which database should we use?")).toHaveLength(2);
    fireEvent.click(getButtonByText(slot, "SQLite"));
    fireEvent.click(getButtonByText(slot, "Submit answer"));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toEqual({
      answers: { q0: { selected: ["q0o1"] } },
    } satisfies InteractionResponse);
  });
  it("passes heading Markdown to the host renderer and keeps the legend readable", () => {
    const prompt =
      "Can you **retry** `vc login` using [the guide](https://example.com)?";
    const slot = render({
      questions: [{ ...singleSelect.questions[0]!, prompt }],
    });
    const heading = slot.getByRole("heading", { level: 2 });
    expect(
      heading.querySelector('[data-testid="bb-markdown"]')?.textContent,
    ).toBe(prompt);
    expect(slot.container.querySelector("legend")?.textContent).toBe(
      "Can you retry vc login using the guide?",
    );
  });
  it("keeps Markdown syntax out of question tab tooltips", () => {
    const first = {
      ...singleSelect.questions[0]!,
      prompt: "Can you **retry** `vc login`?",
    };
    const slot = render({
      questions: [first, { ...first, id: "q1", shortLabel: "Hosting" }],
    });
    expect(getButtonByText(slot, "Database").title).toBe(
      "Can you retry vc login?",
    );
  });
  it("shows an awaiting-answer state", () => {
    const slot = render(singleSelect);
    expect(slot.getByRole("status").textContent).toBe("Needs your answer");
  });
  it("accepts a freeform-only question", () => {
    const submit = vi.fn(async (_value: unknown) => undefined);
    const slot = render(
      { questions: [{ ...singleSelect.questions[0]!, options: [] }] },
      { submit },
    );
    fireEvent.change(slot.getByLabelText("Database answer"), {
      target: { value: "Use our managed service" },
    });
    fireEvent.click(getButtonByText(slot, "Submit answer"));
    expect(submit.mock.calls[0]?.[0]).toEqual({
      answers: { q0: { selected: [], freeText: "Use our managed service" } },
    });
  });
  it("preserves the answer and displays submission failures", async () => {
    const submit = vi.fn(async () => {
      throw new Error("offline");
    });
    const slot = render(singleSelect, { submit });
    fireEvent.click(getButtonByText(slot, "SQLite"));
    fireEvent.click(getButtonByText(slot, "Submit answer"));
    expect((await slot.findByRole("alert")).textContent).toContain(
      "Could not send your answer",
    );
    expect(getButtonByText(slot, "SQLite").getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(getButtonByText(slot, "Submit answer"));
    expect(submit).toHaveBeenCalledTimes(2);
  });
  it("cancels the request instead of submitting", () => {
    const cancel = vi.fn(async () => undefined);
    const slot = render(singleSelect, { cancel });

    fireEvent.click(getButtonByText(slot, "Cancel"));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("offers a cancel escape rather than blocking the composer", () => {
    const cancel = vi.fn(async () => undefined);
    const slot = renderSlot(app.pendingInteractions[0]!, {
      interaction: {
        id: "pint_test",
        threadId: "thr_test",
        title: "Database",
        payload: { questions: "not an array" } as never,
        createdAt: 0,
        expiresAt: null,
      },
      submit: async () => undefined,
      cancel,
    });

    expect(
      slot.getByText("This question could not be displayed."),
    ).toBeTruthy();
    fireEvent.click(getButtonByText(slot, "Cancel"));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("draws the card in the composer banner and leaves the shell a marker", async () => {
    const banner = app.composerCustomizations
      .find((c) => c.id === "recap")!
      .banners!.find((b) => b.id === "question")!;
    const composer = renderSlot(
      banner,
      {},
      { composer: { scope: { kind: "thread", threadId: "thr_test" } } },
    );
    const submit = vi.fn(async (_value: unknown) => undefined);
    const slot = render(singleSelect, { submit });

    const card = await vi.waitFor(() => {
      const found = composer.container.querySelector("[data-ws-question-card]");
      if (!found) throw new Error("card not portaled");
      return found;
    });
    expect(card.textContent).toContain("Which database should we use?");
    expect(slot.container.querySelector(".ws-question-portaled")).toBeTruthy();
    fireEvent.click(getButtonByText(composer, "SQLite"));
    fireEvent.click(getButtonByText(composer, "Submit answer"));
    expect(submit.mock.calls[0]?.[0]).toEqual({
      answers: { q0: { selected: ["q0o1"] } },
    });
  });
});
