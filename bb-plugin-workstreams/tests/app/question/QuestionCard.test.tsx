// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  InteractionPayload,
  InteractionResponse,
} from "../../../src/server/questions/contracts.ts";

const app = await loadPluginApp(() => import("../../../src/app/index.tsx"));
const mockUpload = vi.fn(async (args: any) => {
  const clientFile = args.clientFile as File;
  return {
    type: clientFile.type.startsWith("image/")
      ? ("localImage" as const)
      : ("localFile" as const),
    path: `uploaded/${clientFile.name}`,
    name: clientFile.name,
    sizeBytes: clientFile.size,
    mimeType: clientFile.type,
  };
});

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
  return renderSlot(
    app.pendingInteractions[0]!,
    {
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
    },
    {
      context: { projectId: "project-test", threadId: "thr_test" },
      sdk: { projects: { attachments: { upload: mockUpload } } },
    },
  );
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
  it("restores a durable question and its draft after the native interaction unmounts", async () => {
    sessionStorage.clear();
    const slot = render({
      ...singleSelect,
      durableId: "durable-test",
    } as InteractionPayload);
    fireEvent.click(getButtonByText(slot, "SQLite"));
    slot.lifecycle.unmount();
    const banner = app.composerCustomizations
      .find((c) => c.id === "recap")!
      .banners!.find((b) => b.id === "question")!;
    const recover = vi.fn(async () => ({ ok: true }));
    const composer = renderSlot(
      banner,
      {},
      {
        composer: { scope: { kind: "thread", threadId: "thr_test" } },
        rpc: {
          question_pending: () => ({
            id: "durable-test",
            recoverable: true,
            payload: singleSelect,
          }),
          question_recover: recover,
        },
      },
    );
    await composer.findByText(
      "Needs your answer · Restored after interruption",
    );
    expect(
      getButtonByText(composer, "SQLite").getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(getButtonByText(composer, "Submit"));
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    expect(recover.mock.calls[0]).toEqual([
      expect.objectContaining({
        id: "durable-test",
        value: { answers: { q0: { selected: ["q0o1"] } } },
        dismiss: false,
      }),
    ]);
    sessionStorage.clear();
  });

  it("flushes typed free text on unmount before draft debounce", async () => {
    sessionStorage.clear();
    const slot = render({
      ...singleSelect,
      durableId: "unmount-draft-test",
    } as InteractionPayload);
    fireEvent.click(getButtonByText(slot, "Other…"));
    fireEvent.change(slot.getByRole("textbox", { name: "Database answer" }), {
      target: { value: "typed immediately before interruption" },
    });
    slot.lifecycle.unmount();

    const banner = app.composerCustomizations
      .find((c) => c.id === "recap")!
      .banners!.find((b) => b.id === "question")!;
    const recover = vi.fn(async () => ({ ok: true }));
    const composer = renderSlot(
      banner,
      {},
      {
        composer: { scope: { kind: "thread", threadId: "thr_test" } },
        rpc: {
          question_pending: () => ({
            id: "unmount-draft-test",
            recoverable: true,
            payload: singleSelect,
          }),
          question_recover: recover,
        },
      },
    );
    const restored = await composer.findByRole("textbox", {
      name: "Database answer",
    });
    expect((restored as HTMLTextAreaElement).value).toBe(
      "typed immediately before interruption",
    );
    composer.lifecycle.unmount();
    sessionStorage.clear();
  });

  it("submits the selected option value", () => {
    const submit = vi.fn(async (_value: unknown) => undefined);
    const slot = render(singleSelect, { submit });

    expect(slot.getAllByText("Which database should we use?")).toHaveLength(2);
    fireEvent.click(getButtonByText(slot, "SQLite"));
    fireEvent.click(getButtonByText(slot, "Submit"));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toEqual({
      answers: { q0: { selected: ["q0o1"] } },
    } satisfies InteractionResponse);
  });

  it("shows always-visible details before the answer options", () => {
    const details = "- Old title → New title";
    const slot = render({
      questions: [
        {
          ...singleSelect.questions[0]!,
          details,
        },
      ],
    });
    const prompt = slot.getByRole("heading", {
      name: "Which database should we use?",
    });
    const detailsText = slot.getAllByTestId("bb-markdown")[1]!.parentElement!;
    const option = slot.getByText("Postgres");
    expect(
      prompt.compareDocumentPosition(detailsText) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      detailsText.compareDocumentPosition(option) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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

  it("debounces draft persistence while typing and saves the latest text", async () => {
    sessionStorage.clear();
    const slot = render({
      ...singleSelect,
      durableId: "debounced-draft-test",
    } as InteractionPayload);
    fireEvent.click(getButtonByText(slot, "Other…"));
    const answer = slot.getByRole("textbox", { name: "Database answer" });
    fireEvent.change(answer, { target: { value: "first" } });
    fireEvent.change(answer, { target: { value: "latest answer" } });

    expect(sessionStorage.length).toBe(0);
    await vi.waitFor(() => {
      const value = sessionStorage.getItem(
        "ws-question-draft:debounced-draft-test",
      );
      expect(value).not.toBeNull();
      expect(JSON.parse(value!).q0.otherText).toBe("latest answer");
    });
    sessionStorage.clear();
  });

  it("shows an awaiting-answer state", () => {
    const slot = render(singleSelect);
    expect(slot.getByRole("status").textContent).toBe("Needs your answer");
  });

  it("accepts freeform text in the compact answer field", () => {
    const submit = vi.fn(async (_value: unknown) => undefined);
    const slot = render(
      { questions: [{ ...singleSelect.questions[0]!, options: [] }] },
      { submit },
    );
    fireEvent.change(slot.getByLabelText("Database answer"), {
      target: { value: "Use our managed service" },
    });
    fireEvent.click(getButtonByText(slot, "Submit"));
    expect(submit.mock.calls[0]?.[0]).toEqual({
      answers: { q0: { selected: [], freeText: "Use our managed service" } },
    });
  });

  it("pastes images and attaches files from the plus control", async () => {
    mockUpload.mockClear();
    const slot = render({
      questions: [{ ...singleSelect.questions[0]!, options: [] }],
    });
    const input = slot.container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const inputClick = vi.spyOn(input, "click");
    const image = new File(["image"], "screenshot.png", { type: "image/png" });
    fireEvent.click(
      slot.getByRole("button", { name: "Attach files or images" }),
    );
    expect(inputClick).toHaveBeenCalledOnce();
    const user = userEvent.setup();
    await user.upload(input, image);
    await vi.waitFor(() => expect(mockUpload).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(slot.getByText("screenshot.png")).toBeTruthy(),
    );
    const answer = slot.getByRole("textbox", { name: "Database answer" });
    answer.focus();
    const clipboard = {
      files: [image],
      types: ["Files"],
      getData: () => "",
      items: [{ kind: "file", type: image.type, getAsFile: () => image }],
    };
    await user.paste(clipboard as never);
    await vi.waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(slot.getAllByText("screenshot.png")).toHaveLength(2),
    );
    expect(
      slot.getByRole("button", { name: "Attach files or images" }),
    ).toBeTruthy();
    expect(
      slot.container.querySelector("[data-testid='bb-new-thread-composer']"),
    ).toBeNull();
  });

  it("keeps Submit pending after a successful response until the interaction closes", async () => {
    let resolveSubmit!: () => void;
    const submit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const slot = render(singleSelect, { submit });
    fireEvent.click(getButtonByText(slot, "SQLite"));
    fireEvent.click(getButtonByText(slot, "Submit"));
    expect(getButtonByText(slot, "Submitting…").disabled).toBe(true);
    resolveSubmit();
    await Promise.resolve();
    expect(getButtonByText(slot, "Submitting…").disabled).toBe(true);
  });

  it("preserves the answer and displays submission failures", async () => {
    const submit = vi.fn(async () => {
      throw new Error("offline");
    });
    const slot = render(singleSelect, { submit });
    fireEvent.click(getButtonByText(slot, "SQLite"));
    fireEvent.click(getButtonByText(slot, "Submit"));
    expect((await slot.findByRole("alert")).textContent).toContain(
      "Could not send your answer",
    );
    expect(getButtonByText(slot, "SQLite").getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(getButtonByText(slot, "Submit"));
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
    fireEvent.click(getButtonByText(composer, "Submit"));
    expect(submit.mock.calls[0]?.[0]).toEqual({
      answers: { q0: { selected: ["q0o1"] } },
    });
  });
});
