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
  options: { projectId?: string | null } = {},
) {
  const context =
    options.projectId === null
      ? { threadId: "thr_test" }
      : {
          projectId: options.projectId ?? "project-test",
          threadId: "thr_test",
        };
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
      context,
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
    expect(
      await composer.findByRole("region", {
        name: "Question needs your answer",
      }),
    ).toBeTruthy();
    expect(
      getButtonByText(composer, "SQLite").getAttribute("aria-checked"),
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

  it("offers optional notes once a single-select option is chosen", () => {
    const submit = vi.fn(async (_value: unknown) => undefined);
    const slot = render(singleSelect, { submit });

    expect(slot.queryByLabelText("Database notes")).toBeNull();
    fireEvent.click(getButtonByText(slot, "Postgres"));
    fireEvent.change(slot.getByLabelText("Database notes"), {
      target: { value: "  with pgbouncer  " },
    });
    fireEvent.click(getButtonByText(slot, "SQLite"));
    expect(
      (slot.getByLabelText("Database notes") as HTMLTextAreaElement).value,
    ).toBe("  with pgbouncer  ");
    fireEvent.click(getButtonByText(slot, "Submit"));

    expect(submit.mock.calls[0]?.[0]).toEqual({
      answers: { q0: { selected: ["q0o1"], freeText: "with pgbouncer" } },
    } satisfies InteractionResponse);
  });

  it("drops notes when Other becomes the answer and for multi-select", () => {
    const submit = vi.fn(async (_value: unknown) => undefined);
    const slot = render(singleSelect, { submit });
    fireEvent.click(getButtonByText(slot, "Postgres"));
    fireEvent.change(slot.getByLabelText("Database notes"), {
      target: { value: "kept for Postgres only" },
    });
    fireEvent.click(getButtonByText(slot, "Other…"));
    expect(slot.queryByLabelText("Database notes")).toBeNull();
    fireEvent.change(slot.getByLabelText("Database answer"), {
      target: { value: "DuckDB" },
    });
    fireEvent.click(getButtonByText(slot, "Submit"));
    expect(submit.mock.calls[0]?.[0]).toEqual({
      answers: { q0: { selected: [], freeText: "DuckDB" } },
    });

    cleanup();
    const multi = render({
      questions: [{ ...singleSelect.questions[0]!, multiSelect: true }],
    });
    fireEvent.click(getButtonByText(multi, "Postgres"));
    expect(multi.queryByLabelText("Database notes")).toBeNull();
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

  it("restores the line structure of plain-text details for the host renderer", () => {
    const slot = render({
      questions: [
        {
          ...singleSelect.questions[0]!,
          details: "What I found:\n• first\n• second",
        },
      ],
    });
    expect(slot.getAllByTestId("bb-markdown")[1]!.textContent).toBe(
      "What I found:\n\n- first\n- second",
    );
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

  it("marks the awaiting-answer state with the question's accent, not a label", () => {
    const slot = render(singleSelect);
    expect(slot.queryByRole("status")).toBeNull();
    expect(slot.queryByText("Needs your answer")).toBeNull();
    expect(slot.getByRole("heading", { level: 2 }).className).toContain(
      "text-amber-700",
    );
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

  it("limits freeform answers and explains disabled attachments without a project", () => {
    const slot = render(
      { questions: [{ ...singleSelect.questions[0]!, options: [] }] },
      {},
      { projectId: null },
    );
    const answer = slot.getByLabelText(
      "Database answer",
    ) as HTMLTextAreaElement;
    expect(answer.maxLength).toBe(4096);
    // The count appears only as the answer nears its limit.
    expect(slot.queryByText("0/4096")).toBeNull();
    fireEvent.change(answer, { target: { value: "x".repeat(3300) } });
    expect(slot.getByText("3300/4096")).toBeTruthy();
    expect(
      slot.getByRole("button", { name: "Attach files or images" }),
    ).toHaveProperty("disabled", true);
    expect(slot.getByText("Attachments need a project.")).toBeTruthy();
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
    expect(getButtonByText(slot, "SQLite").getAttribute("aria-checked")).toBe(
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
  it("exposes single-select options as one radio group with a single tab stop", () => {
    const slot = render(singleSelect);
    const group = slot.getByRole("radiogroup");
    const rows = Array.from(group.querySelectorAll('[role="radio"]'));
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Postgres"),
      expect.stringContaining("SQLite"),
      expect.stringContaining("Other…"),
    ]);
    expect(rows.map((row) => row.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);
    fireEvent.click(getButtonByText(slot, "SQLite"));
    expect(rows.map((row) => row.getAttribute("tabindex"))).toEqual([
      "-1",
      "0",
      "-1",
    ]);
  });

  it("moves the choice with the arrow keys, wrapping around", () => {
    const slot = render(singleSelect);
    const postgres = getButtonByText(slot, "Postgres");
    postgres.focus();
    fireEvent.keyDown(postgres, { key: "ArrowDown" });
    expect(getButtonByText(slot, "SQLite").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(getButtonByText(slot, "SQLite"));
    fireEvent.keyDown(getButtonByText(slot, "SQLite"), { key: "ArrowUp" });
    fireEvent.keyDown(getButtonByText(slot, "Postgres"), { key: "ArrowUp" });
    expect(getButtonByText(slot, "Other…").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("exposes multi-select options as checkboxes that are all tabbable", () => {
    const slot = render({
      questions: [{ ...singleSelect.questions[0]!, multiSelect: true }],
    });
    const rows = slot.getAllByRole("checkbox");
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.getAttribute("tabindex") === "0")).toBe(
      true,
    );
  });

  it("shows number hints and binds the digit keys where BB hosts none", () => {
    const slot = render(singleSelect);
    expect(
      Array.from(slot.container.querySelectorAll("kbd")).map(
        (hint) => hint.textContent,
      ),
    ).toEqual(["1", "2", "3"]);
    const postgres = getButtonByText(slot, "Postgres");
    fireEvent.keyDown(postgres, { key: "2" });
    expect(getButtonByText(slot, "SQLite").getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.keyDown(postgres, { key: "3" });
    expect(getButtonByText(slot, "Other…").getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.keyDown(postgres, { key: "9" });
    expect(getButtonByText(slot, "Other…").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("leaves digits to the answer field", () => {
    const slot = render(singleSelect);
    fireEvent.click(getButtonByText(slot, "Other…"));
    const answer = slot.getByRole("textbox", { name: "Database answer" });
    fireEvent.keyDown(answer, { key: "1" });
    expect(getButtonByText(slot, "Postgres").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(getButtonByText(slot, "Other…").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("shows a failed submit in the footer beside the buttons", async () => {
    const submit = vi.fn(async () => {
      throw new Error("offline");
    });
    const slot = render(singleSelect, { submit });
    fireEvent.click(getButtonByText(slot, "SQLite"));
    fireEvent.click(getButtonByText(slot, "Submit"));
    const alert = await slot.findByRole("alert");
    expect(alert.parentElement?.contains(getButtonByText(slot, "Cancel"))).toBe(
      true,
    );
    expect(alert.parentElement?.contains(getButtonByText(slot, "Submit"))).toBe(
      true,
    );
  });

  it("says what Enter does in the answer field", () => {
    const first = {
      ...singleSelect.questions[0]!,
      options: [],
    };
    const slot = render({
      questions: [
        first,
        { ...first, id: "q1", prompt: "Which host?", shortLabel: "Host" },
      ],
    });
    expect(slot.getByText(/Enter for next/)).toBeTruthy();
    fireEvent.click(getButtonByText(slot, "Host"));
    expect(slot.getByText(/Enter to submit/)).toBeTruthy();
  });

  it("fades the edges of a scroll area with content beyond them", () => {
    const slot = render(singleSelect);
    const scroller =
      slot.container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const metrics = { scrollTop: 0, clientHeight: 200, scrollHeight: 500 };
    for (const [key, value] of Object.entries(metrics))
      Object.defineProperty(scroller, key, { configurable: true, value });
    fireEvent.scroll(scroller);
    expect(scroller.style.getPropertyValue("--fade-bottom")).toBe("28px");
    expect(scroller.style.getPropertyValue("--fade-top")).toBe("");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      value: 300,
    });
    fireEvent.scroll(scroller);
    expect(scroller.style.getPropertyValue("--fade-bottom")).toBe("");
    expect(scroller.style.getPropertyValue("--fade-top")).toBe("12px");
  });

  it("keeps Enter for a newline on a phone's soft keyboard", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    const submit = vi.fn(async (_value: unknown) => undefined);
    const slot = render(
      { questions: [{ ...singleSelect.questions[0]!, options: [] }] },
      { submit },
    );
    const answer = slot.getByRole("textbox", { name: "Database answer" });
    fireEvent.change(answer, { target: { value: "SQLite" } });
    fireEvent.keyDown(answer, { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
    expect(slot.queryByText(/Shift\+Enter/)).toBeNull();
  });
  describe("question navigation", () => {
    const second = {
      id: "q1",
      prompt: "Which host?",
      shortLabel: "Hosting",
      multiSelect: false,
      allowFreeText: true,
      options: [
        { value: "q1o0", label: "Vercel", description: "Managed." },
        { value: "q1o1", label: "Fly", description: "Machines." },
      ],
    };
    const two = { questions: [singleSelect.questions[0]!, second] };
    const mockMedia = (matches: boolean) =>
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn((query: string) => ({
          matches,
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });

    it("shows every label as underline tabs and moves between questions", () => {
      const slot = render(two);
      expect(
        getButtonByText(slot, "Database").getAttribute("aria-current"),
      ).toBe("step");
      expect(
        getButtonByText(slot, "Hosting").getAttribute("aria-current"),
      ).toBe(null);
      expect(slot.queryByText("1 of 2")).toBeNull();
      fireEvent.click(getButtonByText(slot, "Hosting"));
      expect(
        getButtonByText(slot, "Hosting").getAttribute("aria-current"),
      ).toBe("step");
      expect(slot.getByText("Vercel")).toBeTruthy();
    });

    it("announces which tabs are answered", () => {
      const slot = render(two);
      fireEvent.click(getButtonByText(slot, "SQLite"));
      expect(getButtonByText(slot, "Database").textContent).toContain(
        ", answered",
      );
      expect(getButtonByText(slot, "Hosting").textContent).not.toContain(
        "answered",
      );
    });

    it("collapses to dots and the current label in a compact viewport", () => {
      mockMedia(true);
      const slot = render(two);
      const dots = slot
        .getAllByRole("button")
        .filter(
          (button) =>
            button.hasAttribute("aria-label") &&
            /^(Database|Hosting)/.test(button.getAttribute("aria-label")!),
        );
      expect(dots.map((dot) => dot.getAttribute("aria-label"))).toEqual([
        "Database",
        "Hosting",
      ]);
      expect(dots[0]!.getAttribute("aria-current")).toBe("step");
      expect(slot.getByText("1 of 2")).toBeTruthy();
      fireEvent.click(getButtonByText(slot, "SQLite"));
      expect(
        slot.getByRole("button", { name: "Database, answered" }),
      ).toBeTruthy();
      fireEvent.click(slot.getByRole("button", { name: "Hosting" }));
      expect(slot.getByText("2 of 2")).toBeTruthy();
      expect(slot.getByText("Vercel")).toBeTruthy();
    });
  });
});
