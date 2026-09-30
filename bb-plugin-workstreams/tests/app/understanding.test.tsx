// @vitest-environment jsdom
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState } from "./fixtures.ts";

afterEach(cleanup);

const evidence = {
  id: "ev-1",
  threadId: "thread-1",
  entryId: "opaque-segment-7",
  speaker: "user" as const,
  quote: "We decided to keep the index local.",
  observation: "The index is intentionally local.",
  epistemic: "explicit" as const,
  terms: ["index", "local"],
  sourceAt: 1_700_000_000_000,
  traceId: "extract-trace",
};
const belief = {
  id: "acct-1",
  name: "Local indexing",
  narrative: "The project keeps indexing local.",
  questions: ["Will remote sync be added?"],
  evidenceIds: [evidence.id],
  updatedAt: 1_700_000_100_000,
  traceId: "synthesis-trace",
};
const overview = {
  accounts: [belief],
  observations: [evidence],
  progress: [
    {
      threadId: "thread-1",
      cursor: "cursor-1",
      status: "completed",
      error: null,
      updatedAt: 1_700_000_100_000,
      dirty: 0,
      completedRevision: 4,
      backlog: 0,
    },
  ],
  counts: { accounts: 1, observations: 1, threads: 1, failed: 0, pending: 0 },
  hasMoreAccounts: false,
  hasMoreObservations: false,
  hasMoreProgress: false,
};
const snapshot = {
  id: "snap-1",
  at: 1_700_000_200_000,
  consumer: "analysis" as const,
  threadId: "thread-1",
  traceId: "consumer-trace",
  report: {
    query: "local index",
    terms: ["local", "index"],
    budget: 1000,
    usedChars: 88,
    context: "Exact consumer context",
    accountIds: [belief.id],
    observationIds: [evidence.id],
    candidates: [],
  },
};

async function mount(subPath = "") {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  return renderSlot(
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
        understandingOverview: () => overview,
        understandingAccount: () => ({
          account: belief,
          evidence: [evidence],
          revisions: [
            {
              id: "rev-2",
              accountId: belief.id,
              at: 1_700_000_100_000,
              action: "revised",
              before: { ...belief, narrative: "An earlier interpretation." },
              after: belief,
              traceId: "synthesis-trace",
              reason: "New evidence added",
            },
          ],
          hasMoreRevisions: false,
        }),
        understandingObservation: () => ({
          observation: evidence,
          accounts: [belief],
          retrievals: [snapshot],
        }),
        understandingRetrieve: () => ({
          ...snapshot.report,
          candidates: [
            {
              kind: "account",
              id: belief.id,
              title: belief.name,
              score: 2,
              matchedTerms: ["local", "index"],
              disposition: "included",
              chars: 88,
            },
            {
              kind: "observation",
              id: "ev-2",
              title: "Another observation",
              score: 1,
              matchedTerms: ["local"],
              disposition: "budget",
              chars: 140,
            },
          ],
        }),
        understandingRetrievals: () => ({ retrievals: [snapshot] }),
      },
    },
  );
}

it("adds an Understanding tab and follows an account to exact evidence and trace inspection", async () => {
  const slot = await mount("understanding/accounts/acct-1");
  expect(
    slot
      .getByRole("tab", { name: "Understanding" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    await slot.findByRole("heading", { name: "Local indexing" }),
  ).toBeTruthy();
  expect(slot.getByText("An earlier interpretation.")).toBeTruthy();
  expect(slot.getByText("New evidence added")).toBeTruthy();
  fireEvent.click(slot.getAllByRole("button", { name: "ev-1" })[0]!);
  expect(
    await slot.findByText("Current accounts citing this evidence"),
  ).toBeTruthy();
  expect(
    slot.getByText("Consumer snapshots citing this evidence"),
  ).toBeTruthy();
  expect(
    slot.getAllByRole("button", { name: /Inspect model call · 1 trace/ })
      .length,
  ).toBeGreaterThan(0);
  slot.lifecycle.unmount();
});

it("runs production retrieval with the chosen query and bounded budget and follows candidates", async () => {
  const slot = await mount("understanding/retrieval");
  fireEvent.change(slot.getByRole("textbox", { name: "Query" }), {
    target: { value: "local index" },
  });
  fireEvent.change(slot.getByRole("spinbutton", { name: /Context budget/ }), {
    target: { value: "1200" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Run retrieval" }));
  expect(await slot.findByText("Exact context sent to consumer")).toBeTruthy();
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.find(
        (call) => call.method === "understandingRetrieve",
      )?.input,
    ).toEqual({ query: "local index", budget: 1200, limit: 24 }),
  );
  expect(slot.getByText("Budget excluded")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Local indexing" }));
  expect(
    await slot.findByText("Current interpretation · not a direct quote"),
  ).toBeTruthy();
  slot.lifecycle.unmount();
});

it("follows an account from a retained consumer snapshot linked on evidence", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "understanding/evidence/ev-1" },
    {
      sidebarThreads: {
        status: "ready",
        threads: [],
        sections: [],
        projects: [],
      },
      rpc: {
        state: () => ({ ...emptyState() }),
        understandingOverview: () => overview,
        understandingObservation: () => ({
          observation: evidence,
          accounts: [belief],
          retrievals: [snapshot],
        }),
        understandingAccount: () => ({
          account: belief,
          evidence: [evidence],
          revisions: [],
          hasMoreRevisions: false,
        }),
      },
    },
  );
  const account = await slot.findByRole("button", { name: /Local indexing/ });
  fireEvent.click(account);
  expect(
    await slot.findByRole("heading", { name: "Local indexing" }),
  ).toBeTruthy();
  slot.lifecycle.unmount();
});

it("labels existing retrieval results when lab inputs no longer match", async () => {
  const slot = await mount("understanding/retrieval");
  fireEvent.change(slot.getByRole("textbox", { name: "Query" }), {
    target: { value: "original run" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Run retrieval" }));
  await slot.findByText("Exact context sent to consumer");
  fireEvent.change(slot.getByRole("textbox", { name: "Query" }), {
    target: { value: "edited query" },
  });
  expect(slot.getByText("Previous run")).toBeTruthy();
  expect(slot.getByText("local index")).toBeTruthy();
  expect(
    slot.queryByRole("tablist", { name: "Understanding views" }),
  ).toBeNull();
  expect(
    slot.getByRole("navigation", { name: "Understanding views" }),
  ).toBeTruthy();
  slot.lifecycle.unmount();
});

it("shows collection health counts/progress and the explicit observe command", async () => {
  const slot = await mount("understanding/health");
  expect(await slot.findByText("Observe one conversation")).toBeTruthy();
  expect(
    slot.getByText("bb workstreams understanding --observe <thread-id>"),
  ).toBeTruthy();
  expect(slot.getByText("completed", { exact: true })).toBeTruthy();
  expect(slot.getByText("4", { exact: true })).toBeTruthy();
  slot.lifecycle.unmount();
});

it("loads actual retrieval snapshots after the exclusive page cursor", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const retrievalCall = vi.fn((input: unknown) => {
    const before = (input as { before?: { id: string } }).before;
    return Promise.resolve({
      retrievals: before
        ? [{ ...snapshot, id: "snap-older", at: snapshot.at - 1000 }]
        : Array.from({ length: 100 }, (_, index) => ({
            ...snapshot,
            id: `snap-${index}`,
            at: snapshot.at - index,
          })),
    });
  });
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "understanding/decisions" },
    {
      sidebarThreads: {
        status: "ready",
        threads: [],
        sections: [],
        projects: [],
      },
      rpc: {
        state: () => ({ ...emptyState() }),
        understandingOverview: () => overview,
        understandingRetrievals: retrievalCall,
      },
    },
  );
  await slot.findByRole("button", { name: "Load older snapshots" });
  fireEvent.click(slot.getByRole("button", { name: "Load older snapshots" }));
  await slot.findByText("snap-older");
  expect(
    retrievalCall.mock.calls.some(
      ([input]) => (input as { before?: unknown }).before !== undefined,
    ),
  ).toBe(true);
  slot.lifecycle.unmount();
});

it("renders overview failures with retry", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const overviewCall = vi
    .fn()
    .mockRejectedValueOnce(new Error("storage unavailable"))
    .mockResolvedValue(overview);
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "understanding" },
    {
      sidebarThreads: {
        status: "ready",
        threads: [],
        sections: [],
        projects: [],
      },
      rpc: {
        state: () => ({ ...emptyState() }),
        understandingOverview: overviewCall,
      },
    },
  );
  expect(await slot.findByRole("alert")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  expect(await slot.findByText("Local indexing")).toBeTruthy();
  slot.lifecycle.unmount();
});

it("keeps the primary workspace usable at a 390px viewport", async () => {
  const slot = await mount("understanding/retrieval");
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  window.dispatchEvent(new Event("resize"));
  const root = slot.container.querySelector(".understanding");
  expect(root).toBeTruthy();
  expect(
    slot.getByRole("navigation", { name: "Understanding views" }),
  ).toBeTruthy();
  expect(slot.getByRole("textbox", { name: "Query" })).toBeTruthy();
  expect(slot.getByRole("spinbutton", { name: /Context budget/ })).toBeTruthy();
  expect(
    slot
      .getByRole("button", { name: "Run retrieval" })
      .classList.contains("understanding__run"),
  ).toBe(true);
  const css = await readFile("src/app/understanding/understanding.css", "utf8");
  expect(css).toContain("@media (max-width: 640px)");
  expect(css).toContain(".understanding__list");
  expect(css).toContain("max-height: 38vh");
  slot.lifecycle.unmount();
});

it.skipIf(!process.env.UNDERSTANDING_CAPTURE_DIR)(
  "exports the final Understanding fixture for standalone browser capture",
  async () => {
    const directory = process.env.UNDERSTANDING_CAPTURE_DIR!;
    await mkdir(directory, { recursive: true });
    const css = await readFile(
      "src/app/understanding/understanding.css",
      "utf8",
    );
    const utilityCssPath = process.env.UNDERSTANDING_HOST_CSS ?? "dist/app.css";
    const productionCss = await readFile(utilityCssPath, "utf8");
    const tokens = `:root{color-scheme:dark;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}*{box-sizing:border-box}body{margin:0;background:#101311;color:#e8e9e7;padding:24px 16px}button,input{font:inherit;color:inherit}p{margin:0}.capture-shell{max-width:1040px;margin:0 auto}.capture-shell.dark{color-scheme:dark;--canvas:#141715;--ink:#e8e9e7;--background:#141715;--foreground:#e8e9e7;--muted-foreground:#989c9a;--border:#343a38;--input:#343a38;--state-active:#28342e;--state-hover:#252b28;--surface-raised:#1c211e;--ring:#91b5ff;--destructive:#ee7777;--font-sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}button{cursor:pointer}@media(max-width:640px){body{padding:12px 8px}}`;
    for (const [name, path] of [
      ["accounts", "understanding/accounts/acct-1"],
      ["retrieval", "understanding/retrieval"],
    ]) {
      const slot = await mount(path);
      if (name === "accounts") {
        await waitFor(() => {
          expect(
            slot.getByRole("heading", { name: "Local indexing" }),
          ).toBeTruthy();
          expect(slot.getByText("An earlier interpretation.")).toBeTruthy();
          expect(slot.getByText("New evidence added")).toBeTruthy();
          expect(slot.queryByText("Loading understanding…")).toBeNull();
          expect(slot.queryByText("Loading detail…")).toBeNull();
          expect(slot.queryByRole("alert")).toBeNull();
        });
      } else {
        fireEvent.change(slot.getByRole("textbox", { name: "Query" }), {
          target: { value: "local index" },
        });
        fireEvent.click(slot.getByRole("button", { name: "Run retrieval" }));
        await slot.findByText("Exact context sent to consumer");
        await slot.findByText("Budget excluded");
      }
      expect(slot.queryByText("Loading understanding…")).toBeNull();
      expect(slot.queryByText("Loading detail…")).toBeNull();
      const markup = slot.container.querySelector(".understanding")?.outerHTML;
      if (!markup) throw new Error("Understanding component was not rendered");
      await writeFile(
        join(directory, `${name}.html`),
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${tokens}</style><style>${productionCss}</style><style>${tokens}</style><style>${css}</style><div class="capture-shell dark">${markup}</div>`,
      );
      slot.lifecycle.unmount();
    }
  },
);

it("loads additional overview and revision pages using offset and exclusive before", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const secondBelief = { ...belief, id: "acct-2", name: "Second account" };
  const overviewCall = vi.fn((input: unknown) =>
    Promise.resolve(
      (input as { offset?: number }).offset
        ? { ...overview, accounts: [secondBelief], hasMoreAccounts: false }
        : { ...overview, hasMoreAccounts: true },
    ),
  );
  const accountCall = vi.fn((input: unknown) => {
    const before = (input as { before?: number }).before;
    return Promise.resolve(
      before !== undefined
        ? {
            account: belief,
            evidence: [evidence],
            revisions: [
              {
                id: "rev-earlier",
                accountId: belief.id,
                at: 949,
                action: "created" as const,
                before: null,
                after: belief,
                traceId: null,
                reason: "Original",
              },
            ],
            hasMoreRevisions: false,
          }
        : {
            account: belief,
            evidence: [evidence],
            revisions: Array.from({ length: 50 }, (_, index) => ({
              id: `rev-${index}`,
              accountId: belief.id,
              at: 1000 - index,
              action: "revised" as const,
              before: belief,
              after: belief,
              traceId: null,
              reason: `Revision ${index}`,
            })),
            hasMoreRevisions: true,
          },
    );
  });
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "understanding/accounts/acct-1" },
    {
      sidebarThreads: {
        status: "ready",
        threads: [],
        sections: [],
        projects: [],
      },
      rpc: {
        state: () => ({ ...emptyState() }),
        understandingOverview: overviewCall,
        understandingAccount: accountCall,
      },
    },
  );
  await slot.findByRole("button", { name: "Load earlier revisions" });
  fireEvent.click(slot.getByRole("button", { name: "Load earlier revisions" }));
  await slot.findByText("Original");
  expect(
    accountCall.mock.calls.some(
      ([input]) =>
        JSON.stringify(input) === JSON.stringify({ id: "acct-1", before: 951 }),
    ),
  ).toBe(true);
  fireEvent.click(slot.getByRole("button", { name: "Load more" }));
  expect(
    await slot.findByRole("button", { name: /Second account/ }),
  ).toBeTruthy();
  expect(overviewCall.mock.calls[1]?.[0]).toMatchObject({
    offset: 80,
    limit: 80,
  });
  slot.lifecycle.unmount();
});

it("refreshes the selected detail without changing selection", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const accountCall = vi
    .fn()
    .mockResolvedValueOnce({
      account: belief,
      evidence: [],
      revisions: [],
      hasMoreRevisions: false,
    })
    .mockResolvedValueOnce({
      account: { ...belief, narrative: "Refreshed narrative" },
      evidence: [],
      revisions: [],
      hasMoreRevisions: false,
    });
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "understanding/accounts/acct-1" },
    {
      sidebarThreads: {
        status: "ready",
        threads: [],
        sections: [],
        projects: [],
      },
      rpc: {
        state: () => ({ ...emptyState() }),
        understandingOverview: () => overview,
        understandingAccount: accountCall,
      },
    },
  );
  expect(
    await slot.findByText("The project keeps indexing local."),
  ).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
  expect(await slot.findByText("Refreshed narrative")).toBeTruthy();
  expect(accountCall).toHaveBeenCalledTimes(3);
  slot.lifecycle.unmount();
});

it("decodes deep-linked IDs for typed RPC requests", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const accountCall = vi.fn((input: unknown) =>
    Promise.resolve({
      account: {
        ...belief,
        id: (input as { id: string }).id,
        name: "Decoded account",
      },
      evidence: [],
      revisions: [],
      hasMoreRevisions: false,
    }),
  );
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "understanding/accounts/id%2Fpart" },
    {
      sidebarThreads: {
        status: "ready",
        threads: [],
        sections: [],
        projects: [],
      },
      rpc: {
        state: () => ({ ...emptyState() }),
        understandingOverview: () => overview,
        understandingAccount: accountCall,
      },
    },
  );
  expect(
    await slot.findByRole("heading", { name: "Decoded account" }),
  ).toBeTruthy();
  expect(accountCall.mock.calls[0]?.[0]).toEqual({ id: "id/part" });
  slot.lifecycle.unmount();
});

it("ignores stale detail responses after selection changes", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  let resolveFirst!: (value: unknown) => void;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const accountCall = vi.fn((input: unknown) =>
    (input as { id: string }).id === "slow"
      ? first
      : Promise.resolve({
          account: { ...belief, id: "fast", name: "Fast result" },
          evidence: [],
          revisions: [],
          hasMoreRevisions: false,
        }),
  );
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "understanding/accounts/slow" },
    {
      sidebarThreads: {
        status: "ready",
        threads: [],
        sections: [],
        projects: [],
      },
      rpc: {
        state: () => ({ ...emptyState() }),
        understandingOverview: () => overview,
        understandingAccount: accountCall,
      },
    },
  );
  fireEvent.click(await slot.findByRole("button", { name: /Local indexing/ }));
  expect(await slot.findByText("Fast result")).toBeTruthy();
  resolveFirst({
    account: { ...belief, name: "Stale result" },
    evidence: [],
    revisions: [],
    hasMoreRevisions: false,
  });
  await waitFor(() => expect(slot.queryByText("Stale result")).toBeNull());
  slot.lifecycle.unmount();
});
