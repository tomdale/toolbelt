// @vitest-environment jsdom
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState } from "./fixtures.ts";

afterEach(cleanup);

const notebook = {
  threadId: "thread-1",
  title: "Planning a local index",
  text: "## Decision\nKeep the index local.\n\nWe can revisit after launch.",
  updatedAt: 1_700_000_100_000,
  cursor: "cursor-1",
  revision: 2,
  error: null,
};
const version = {
  id: "version-1",
  threadId: "thread-1",
  text: "Earlier notebook text.",
  at: 1_700_000_000_000,
  runId: "run-old",
};
const brief = {
  text: "The project is keeping its search index local for now.",
  updatedAt: 1_700_000_100_000,
};
const step = {
  tool: "read_thread",
  input: "thread-1",
  output: "The conversation covered local indexing.",
  at: 1_700_000_050_000,
};
const run = {
  id: "run-1",
  threadId: "thread-1",
  question: "What have we decided?",
  status: "running" as const,
  startedAt: 1_700_000_050_000,
  finishedAt: null,
  summary: "The current decision is to keep the index local.",
  error: null,
  steps: [step],
  usage: { input: 1200, output: 180, cost: 0.002 },
  model: "test-model",
};
const overview = {
  brief,
  notebooks: [notebook],
  runs: [run],
  running: true,
  totalNotebooks: 1,
};

async function mount({
  data = overview,
  rpc = {},
  subPath = "understanding",
}: {
  data?: typeof overview;
  rpc?: Record<string, (...args: any[]) => any>;
  subPath?: string;
} = {}) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath },
    {
      sidebarThreads: {
        status: "ready",
        threads: [],
        sections: [],
        projects: [],
      },
      rpc: {
        state: () => ({ ...emptyState() }),
        notebookOverview: () => data,
        notebook: () => ({ notebook, versions: [version] }),
        notebookBriefVersions: () => ({ versions: [version] }),
        notebookLearn: () => data,
        notebookAsk: () => run,
        notebookRun: () => ({ run }),
        notebookCancel: () => ({ cancelled: true }),
        ...rpc,
      },
    },
  );
  return slot;
}

it("shows the shared brief and a readable notebook, with a normal source link", async () => {
  const slot = await mount();
  expect(await slot.findByText(brief.text)).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Notebooks" }));
  fireEvent.click(
    await slot.findByRole("button", { name: /Planning a local index/ }),
  );
  await waitFor(() =>
    expect(
      slot.container.querySelectorAll(
        ".understanding__detail [data-testid='bb-markdown']",
      ).length,
    ).toBeGreaterThan(0),
  );
  expect(
    slot.container.querySelector(
      ".understanding__detail [data-testid='bb-markdown']",
    )?.textContent,
  ).toContain("Keep the index local.");
  fireEvent.click(slot.getByRole("button", { name: "Open conversation" }));
  expect(slot.inspection.navigateCalls).toContainEqual({
    method: "toThread",
    threadId: "thread-1",
  });
  slot.lifecycle.unmount();
});

it("explains empty state and leaves the shared brief empty when no learning exists", async () => {
  const empty = {
    brief: { text: "", updatedAt: 0 },
    notebooks: [],
    runs: [],
    running: false,
    totalNotebooks: 0,
  };
  const slot = await mount({ data: empty });
  expect(
    await slot.findByText("The shared brief is empty for now."),
  ).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Notebooks" }));
  expect(
    await slot.findByText(
      /Automatic learning can be enabled in plugin settings/,
    ),
  ).toBeTruthy();
  expect(slot.getByLabelText("Learn from a thread")).toBeTruthy();
  slot.lifecycle.unmount();
});

it("requires explicit paid learn action for a thread ID and loads the resulting notebook", async () => {
  const learn = vi.fn().mockResolvedValue(overview);
  const slot = await mount({ rpc: { notebookLearn: learn } });
  fireEvent.click(slot.getByRole("button", { name: "Notebooks" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Thread ID" }), {
    target: { value: "thread-new" },
  });
  expect(
    slot.getByText(/Paid model call · writes this thread’s notebook/),
  ).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Learn" }));
  await waitFor(() =>
    expect(learn).toHaveBeenCalledWith({ threadId: "thread-new" }),
  );
  expect(await slot.findByText("Planning a local index")).toBeTruthy();
  slot.lifecycle.unmount();
});

it("asks a paid read-only question and shows run summary, tool steps, and cancel", async () => {
  const ask = vi.fn().mockResolvedValue(run);
  const cancel = vi.fn().mockResolvedValue({ cancelled: true });
  const runPoll = vi.fn().mockResolvedValue({ run });
  const slot = await mount({
    rpc: { notebookAsk: ask, notebookCancel: cancel, notebookRun: runPoll },
  });
  fireEvent.change(slot.getByRole("textbox", { name: "Ask the learner" }), {
    target: { value: "  What have we decided?  " },
  });
  expect(
    slot.getByText(/Read-only question · uses a paid model call/),
  ).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Ask" }));
  await waitFor(() =>
    expect(ask).toHaveBeenCalledWith({ question: "What have we decided?" }),
  );
  expect(
    await slot.findByText("The current decision is to keep the index local."),
  ).toBeTruthy();
  fireEvent.click(slot.getByText(/What the learner did \(1 steps\)/));
  expect(
    slot.getByText("The conversation covered local indexing."),
  ).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith({ id: "run-1" }));
  slot.lifecycle.unmount();
});

it("keeps a late notebook response from replacing a newer selection", async () => {
  let resolveFirst!: (value: unknown) => void;
  const notebookCall = vi.fn(({ threadId }: { threadId: string }) =>
    threadId === "thread-1"
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve({
          notebook: {
            ...notebook,
            threadId: "thread-2",
            title: "New selection",
            text: "New notebook.",
          },
          versions: [],
        }),
  );
  const two = { ...notebook, threadId: "thread-2", title: "New selection" };
  const slot = await mount({
    data: { ...overview, notebooks: [notebook, two], totalNotebooks: 2 },
    rpc: { notebook: notebookCall },
  });
  fireEvent.click(slot.getByRole("button", { name: "Notebooks" }));
  fireEvent.click(
    await slot.findByRole("button", { name: /Planning a local index/ }),
  );
  fireEvent.click(slot.getByRole("button", { name: /New selection/ }));
  expect(await slot.findByText("New notebook.")).toBeTruthy();
  resolveFirst({ notebook, versions: [version] });
  await waitFor(() =>
    expect(slot.queryByText("Keep the index local.")).toBeNull(),
  );
  slot.lifecycle.unmount();
});

it("shows overview errors with retry", async () => {
  const call = vi
    .fn()
    .mockRejectedValueOnce(new Error("storage unavailable"))
    .mockResolvedValue(overview);
  const slot = await mount({ rpc: { notebookOverview: call } });
  expect(await slot.findByRole("alert")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  expect(await slot.findByText(brief.text)).toBeTruthy();
  slot.lifecycle.unmount();
});

it("records an expandable brief history", async () => {
  const slot = await mount();
  await slot.findByText(brief.text);
  fireEvent.click(slot.getByRole("button", { name: "History" }));
  expect(await slot.findByText("Earlier notebook text.")).toBeTruthy();
  slot.lifecycle.unmount();
});

it("exports the rendered notebook desk for standalone browser capture", async () => {
  if (!process.env.UNDERSTANDING_CAPTURE_DIR) return;
  const directory = process.env.UNDERSTANDING_CAPTURE_DIR;
  await mkdir(directory, { recursive: true });
  const css = await readFile("src/app/understanding/understanding.css", "utf8");
  const hostCss = await readFile(
    process.env.UNDERSTANDING_HOST_CSS ?? "dist/app.css",
    "utf8",
  );
  const tokens = `:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:#101311;color:#e8e9e7;padding:24px 16px}.capture-shell{max-width:1040px;margin:auto;--background:#141715;--foreground:#e8e9e7;--muted-foreground:#989c9a;--border:#343a38;--input:#343a38;--state-active:#28342e;--state-hover:#252b28;--surface-raised:#1c211e;--ring:#91b5ff;--destructive:#ee7777;--font-sans:ui-sans-serif,system-ui,sans-serif}button,input{font:inherit;color:inherit}`;
  for (const [name, path] of [
    ["brief", "understanding"],
    ["notebooks", "understanding/notebooks"],
  ]) {
    const slot = await mount({ subPath: path });
    if (name === "notebooks") {
      fireEvent.click(slot.getByRole("button", { name: "Notebooks" }));
      fireEvent.click(await slot.findByRole("button", { name: /Planning a local index/ }));
      await slot.findByText(/Keep the index local\./, { selector: ".understanding__detail .understanding__markdown" });
    } else await slot.findByText(brief.text);
    const markup = slot.container.querySelector(".understanding")?.outerHTML;
    if (!markup) throw new Error("Notebook explorer was not rendered");
    await writeFile(
      join(directory, `${name}.html`),
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${tokens}</style><style>${hostCss}</style><style>${tokens}</style><style>${css}</style><div class="capture-shell">${markup}</div>`,
    );
    slot.lifecycle.unmount();
  }
});
