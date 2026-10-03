// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, sidebarThread } from "./fixtures.ts";

const interactionOverride = vi.hoisted(() => ({
  value: null as boolean | null,
}));
vi.mock("@get-bb/plugin-sdk/app", async (importActual) => {
  const actual = await importActual<typeof import("@get-bb/plugin-sdk/app")>();
  const React = await import("react");
  return {
    ...actual,
    Markdown: (props: React.ComponentProps<typeof actual.Markdown>) =>
      React.createElement(
        "div",
        {
          "data-testid": "recap-markdown-document",
          "data-thread-id": props.experimental_document?.threadId,
          "data-root-path": props.experimental_document?.rootPath,
          "data-target": JSON.stringify(props.experimental_document?.target),
        },
        React.createElement(actual.Markdown, props),
      ),
    experimental_useSidebarThreads: () => {
      const state = actual.experimental_useSidebarThreads();
      return interactionOverride.value === null
        ? state
        : {
            ...state,
            threads: state.threads.map((thread) =>
              thread.id === "t1"
                ? {
                    ...thread,
                    hasPendingInteraction: interactionOverride.value,
                  }
                : thread,
            ),
          };
    },
  };
});

// The harness's composer can't start a send after mount, so tests force the
// sending state through this override; null defers to the real hook.
const sendingOverride = vi.hoisted(() => ({ value: null as boolean | null }));
vi.mock("../../src/app/composer/useContinuing.ts", async (importActual) => {
  const actual =
    await importActual<
      typeof import("../../src/app/composer/useContinuing.ts")
    >();
  return {
    ...actual,
    useContinuing: (input: Parameters<typeof actual.useContinuing>[0]) => {
      const real = actual.useContinuing(input);
      return sendingOverride.value ?? real;
    },
  };
});

afterEach(() => {
  sendingOverride.value = null;
  interactionOverride.value = null;
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Radix sizes a hint's arrow with a ResizeObserver, which jsdom lacks.
function stubResizeObserver() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

const RECAP = {
  id: "r1",
  turnId: "turn",
  at: 1,
  state: "complete",
  goal: "Building the card",
  latest: ["Card renders"],
  review: [],
  links: [],
  next: [],
};

async function mount(
  options: {
    layout?: string;
    composer?: { text?: string };
    hashDigits?: string;
    hashLetters?: string;
    recap?: Record<string, unknown> | null;
    capped?: boolean;
    archivable?: boolean;
    pendingThreadId?: string;
    threads?: ReturnType<typeof sidebarThread>[];
    archive?: () => { ok: boolean } | Promise<{ ok: boolean }>;
    send?: (input: unknown) => { ok: boolean } | Promise<{ ok: boolean }>;
    agents?: (input: { threadIds: string[] }) => { agents: unknown[] };
  } = {},
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const banner = app.composerCustomizations.find((c) => c.id === "recap")!
    .banners![0]!;
  let recap =
    options.recap === null ? null : { ...RECAP, ...(options.recap ?? {}) };
  let dismissed = false;
  let waitingCancelled = false;
  return renderSlot(
    banner,
    {},
    {
      composer: {
        ...options.composer,
        scope: { kind: "thread", threadId: "t1" },
      },
      sidebarThreads: {
        sections: [
          { id: "ws", name: "Workstream", createdAt: 0, updatedAt: 0 },
        ],
        threads: options.threads ?? [
          sidebarThread("t1", {
            latestAttentionAt: 500,
            hasPendingInteraction: options.pendingThreadId === "t1",
          }),
          sidebarThread("other", {
            hasPendingInteraction: options.pendingThreadId === "other",
          }),
        ],
      },
      rpc: {
        recapPrefs: () => ({
          prefs: {
            required: true,
            corrections: 3,
            layout: options.layout ?? "full",
            hashDigits: options.hashDigits ?? null,
            hashLetters: options.hashLetters ?? null,
          },
        }),
        state: () => emptyState(),
        archiveStatus: () => ({
          recapId: options.archivable ? (recap?.id ?? null) : null,
        }),
        archive: options.archive ?? (() => ({ ok: true })),
        recap_get: () => ({
          recap,
          dismissed,
          waitingCancelled,
          capped: options.capped ?? false,
          corrections: 3,
          files: { environmentId: "env_1", root: "/work", hostId: "host_1" },
        }),
        recap_dismiss: () => {
          dismissed = true;
          if (recap?.state === "waiting") waitingCancelled = true;
          return { ok: true };
        },
        recap_restore: () => {
          dismissed = false;
          return { ok: true };
        },
        recap_send:
          options.send ??
          (() => {
            throw new Error("unexpected recap_send");
          }),
        recap_agents: (input: unknown) =>
          options.agents?.(input as { threadIds: string[] }) ?? { agents: [] },
      },
    },
  );
}

it("opens the next thread in the workstream only after archive succeeds", async () => {
  let resolve!: (value: { ok: boolean }) => void;
  const archived = new Promise<{ ok: boolean }>((done) => {
    resolve = done;
  });
  const slot = await mount({
    archivable: true,
    threads: [
      sidebarThread("t1", { sectionId: "ws", latestAttentionAt: 500 }),
      sidebarThread("next", { sectionId: "ws", latestAttentionAt: 400 }),
      sidebarThread("elsewhere", { latestAttentionAt: 450 }),
    ],
    archive: () => archived,
  });
  fireEvent.click(await slot.findByRole("button", { name: "Archive" }));
  expect(slot.inspection.sidebarActionCalls).toEqual([]);
  resolve({ ok: true });
  await waitFor(() =>
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "next" },
    ]),
  );
});

it("opens the first remaining Up Next thread after archive", async () => {
  const slot = await mount({
    archivable: true,
    threads: [
      sidebarThread("t1", { sectionId: "ws", latestAttentionAt: 500 }),
      sidebarThread("waiting-first", {
        sectionId: "ws",
        hasPendingInteraction: true,
        latestAttentionAt: 400,
      }),
      sidebarThread("waiting-second", {
        sectionId: "ws",
        hasPendingInteraction: true,
        latestAttentionAt: 300,
      }),
      sidebarThread("same-workstream", {
        sectionId: "ws",
        latestAttentionAt: 200,
      }),
    ],
  });
  fireEvent.click(await slot.findByRole("button", { name: "Archive" }));
  await waitFor(() =>
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "waiting-first" },
    ]),
  );
});

it("does not navigate when archive fails", async () => {
  const slot = await mount({
    archivable: true,
    archive: async () => {
      throw new Error("Outstanding work");
    },
  });
  fireEvent.click(await slot.findByRole("button", { name: "Archive" }));
  await slot.findByText("Outstanding work");
  expect(slot.inspection.sidebarActionCalls).toEqual([]);
});

it("does not leave the workstream when its last thread is archived", async () => {
  const slot = await mount({
    archivable: true,
    threads: [
      sidebarThread("t1", { sectionId: "ws" }),
      sidebarThread("elsewhere"),
    ],
  });
  fireEvent.click(await slot.findByRole("button", { name: "Archive" }));
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "state").length,
    ).toBeGreaterThan(1),
  );
  expect(slot.inspection.sidebarActionCalls).toEqual([]);
});

it("renders structured subrows for completed items", async () => {
  const slot = await mount({
    recap: {
      latest: [
        {
          text: "Changed the recap parser",
          detail: "Legacy strings still work",
        },
        "Added compatibility coverage",
      ],
    },
  });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("Changed the recap parser");
  expect(region.textContent).toContain("Legacy strings still work");
  expect(region.textContent).toContain("Added compatibility coverage");
  expect(region.querySelectorAll('li[data-progress="done"]')).toHaveLength(2);
  expect(slot.getByText("Legacy strings still work").className).toContain(
    "text-muted-foreground",
  );
  expect(
    slot.getByText("Legacy strings still work").parentElement?.tagName,
  ).toBe("DIV");
});

it("renders a linked thread mention in the Waiting goal title", async () => {
  const slot = await mount({
    threads: [
      sidebarThread("t1"),
      sidebarThread("thr_tests", { title: "Test worker" }),
    ],
    recap: {
      state: "waiting",
      goal: "Running tests with @thread:thr_tests",
      timeout: 60,
      at: Date.now(),
      latest: [],
    },
  });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("Running tests with Test worker");
  expect(slot.getByLabelText("Status check countdown")).toBeTruthy();
});

it("shows the goal, latest results, and Dismiss under them", async () => {
  const slot = await mount();
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(slot.getByRole("heading", { name: "Building the card" })).toBeTruthy();
  expect(region.textContent).toContain("Card renders");
  expect(region.textContent).toContain("Complete");
  expect(slot.queryByRole("heading", { name: "Done" })).toBeNull();
  expect(slot.queryByRole("heading", { name: "Review" })).toBeNull();
  expect(slot.queryByRole("heading", { name: "Links" })).toBeNull();
  expect(slot.getByRole("button", { name: "Dismiss recap" })).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Archive" })).toBeNull();
});

it.each(["full", "minimal"])(
  "renders recap heading Markdown through the host renderer in %s",
  async (layout) => {
    const goal =
      "Fixed **login** with `vc login` and [the guide](https://example.com)";
    const slot = await mount({ layout, recap: { goal } });
    await slot.findByRole("region", { name: "Latest recap" });
    const heading = slot.getByRole("heading", { level: 2 });
    expect(
      heading.querySelector('[data-testid="bb-markdown"]')?.textContent,
    ).toBe(goal);
  },
);

it.each(["full", "minimal"])(
  "hides links on stored complete recaps in %s",
  async (layout) => {
    const slot = await mount({
      layout,
      recap: {
        links: [{ title: "Source", location: "/work/src/settings.ts" }],
      },
    });
    await slot.findByRole("region", { name: "Latest recap" });
    expect(slot.queryByRole("list", { name: "Links" })).toBeNull();
    expect(slot.queryByText("Source")).toBeNull();
  },
);

const WORKING = {
  state: "waiting",
  goal: "Workers and tests are running",
  timeout: 60,
  at: Date.now(),
  latest: [],
};
const progress = (region: HTMLElement) =>
  [...region.querySelectorAll("li[data-progress]")].map(
    (li) => `${li.getAttribute("data-progress")}:${li.textContent}`,
  );

it("shows the Waiting goal as the title and the countdown in the footer", async () => {
  const slot = await mount({ recap: WORKING });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("Waiting");
  const goalHeading = slot.getByRole("heading", {
    name: /Workers and tests are running/,
  });
  const countdown = slot.getByLabelText("Status check countdown");
  expect(countdown.textContent).toMatch(/^[01]:\d{2}$/);
  expect(goalHeading.contains(countdown)).toBe(false);
  expect(countdown.parentElement?.textContent).toMatch(
    /^Next check in [01]:\d{2}$/,
  );
  const progress = slot.getByTestId("status-check-progress");
  expect(progress.style.width).toMatch(/%$/);
  expect(
    slot.queryByRole("button", { name: "Cancel status check" }),
  ).toBeNull();
  expect(slot.queryByRole("list", { name: "Awaited agents" })).toBeNull();
  expect(slot.queryByRole("heading", { name: "Next" })).toBeNull();
  expect(slot.queryByRole("heading", { name: "Review" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Archive" })).toBeNull();
});

it("says the check is due once the countdown runs out", async () => {
  const slot = await mount({
    recap: { ...WORKING, at: Date.now() - 120_000 },
  });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("Checking now");
  expect(slot.queryByLabelText("Status check countdown")).toBeNull();
  expect(slot.queryByTestId("status-check-progress")).toBeNull();
});

it.each(["full", "minimal"])(
  "uses the Waiting goal as the title (%s)",
  async (layout) => {
    const slot = await mount({
      layout,
      recap: { ...WORKING, goal: "Build the release" },
    });
    await slot.findByRole("region", { name: "Latest recap" });
    const heading = slot.getByRole("heading", { name: "Build the release" });
    expect(
      heading.querySelector("[data-testid='bb-markdown']")?.className,
    ).toContain(layout === "minimal" ? "0.6875rem" : "0.8125rem");
    expect(slot.getByLabelText("Status check countdown").textContent).toMatch(
      /^[01]:\d{2}$/,
    );
  },
);

it.each(["full", "minimal"])(
  "cancels the status check when the waiting card is dismissed (%s)",
  async (layout) => {
    const slot = await mount({ layout, recap: WORKING });
    fireEvent.click(await slot.findByRole("button", { name: "Dismiss recap" }));
    await waitFor(() =>
      expect(slot.queryByRole("region", { name: "Latest recap" })).toBeNull(),
    );
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "recap_dismiss",
      input: { threadId: "t1", recapId: "r1" },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Show recap" }));
    const region = await slot.findByRole("region", { name: "Latest recap" });
    await waitFor(() =>
      expect(region.textContent).toContain("Check cancelled"),
    );
    expect(region.textContent).toContain("Workers and tests are running");
    expect(slot.queryByLabelText("Status check countdown")).toBeNull();
    expect(slot.queryByTestId("status-check-progress")).toBeNull();
  },
);

it.each([1, 2])(
  "lists %i awaited agents under the goal with links and live status",
  async (agentCount) => {
    const agents = [
      { threadId: "thr_ui_agent", task: "Building the theme toggle UI" },
      { threadId: "thr_server_agent", task: "Adding theme preference support" },
    ].slice(0, agentCount);
    const slot = await mount({
      recap: {
        ...WORKING,
        goal: "Building the theme toggle",
        waitingAgents: agents,
      },
      threads: [
        sidebarThread("t1"),
        sidebarThread("thr_ui_agent", { title: "UI agent", status: "active" }),
        sidebarThread("thr_server_agent", { title: "Server agent" }),
      ],
    });
    const region = await slot.findByRole("region", { name: "Latest recap" });
    expect(region.textContent).toContain("Waiting");
    expect(
      slot.getByRole("heading", { name: "Building the theme toggle" }),
    ).toBeTruthy();
    const list = slot.getByRole("list", { name: "Awaited agents" });
    const rows = [...list.querySelectorAll("li")];
    expect(rows.map((row) => row.getAttribute("data-agent-status"))).toEqual(
      ["running", "done"].slice(0, agentCount),
    );
    expect(rows[0]!.textContent).toContain("Building the theme toggle UI");
    expect(rows[0]!.textContent).toContain("Running");
    expect(
      rows[0]!.querySelector("[aria-label='Agent status']")?.className,
    ).toContain("sr-only");
    expect(slot.getByRole("link", { name: "UI agent" })).toBeTruthy();
    if (agentCount === 2) {
      expect(rows[1]!.textContent).toContain("Adding theme preference support");
      expect(rows[1]!.textContent).toContain("Finished");
      expect(slot.getByRole("link", { name: "Server agent" })).toBeTruthy();
    } else {
      expect(slot.queryByRole("link", { name: "Server agent" })).toBeNull();
    }
    expect(
      slot.getByLabelText("Status check countdown").parentElement?.textContent,
    ).toMatch(/^Next check in /);
  },
);

it("reads hidden agent threads from the server", async () => {
  const slot = await mount({
    recap: {
      ...WORKING,
      waitingAgents: [
        { threadId: "thr_hidden", task: "Run the suite" },
        { threadId: "thr_gone", task: "Lint the code" },
      ],
    },
    agents: ({ threadIds }) => ({
      agents: threadIds.includes("thr_hidden")
        ? [
            {
              threadId: "thr_hidden",
              projectId: "proj_1",
              title: "Suite runner",
              status: "active",
              runtimeStatus: "active",
              hasPendingInteraction: false,
              isArchived: false,
            },
          ]
        : [],
    }),
  });
  const list = await slot.findByRole("list", { name: "Awaited agents" });
  const link = await slot.findByRole("link", { name: "Suite runner" });
  expect(link.getAttribute("href")).toBe("/projects/proj_1/threads/thr_hidden");
  const rows = [...list.querySelectorAll("li")];
  expect(rows.map((row) => row.getAttribute("data-agent-status"))).toEqual([
    "running",
    "unknown",
  ]);
  expect(rows[0]!.textContent).toContain("Suite runner");
  expect(rows[0]!.textContent).toContain("Run the suite");
  expect(rows[0]!.textContent).toContain("Running");
  expect(rows[1]!.textContent).toContain("Agent");
  expect(rows[1]!.textContent).toContain("Unavailable");
  expect(slot.inspection.rpcCalls).toContainEqual({
    method: "recap_agents",
    input: { threadIds: ["thr_hidden", "thr_gone"] },
  });
});

it.each([
  [{ hasPendingInteraction: true }, "input", "Needs input"],
  [
    { status: "error" as const, runtimeStatus: "error" as const },
    "error",
    "Errored",
  ],
  [
    { status: "idle" as const, runtimeStatus: "provisioning" as const },
    "running",
    "Starting",
  ],
])("shows an awaited agent's status %#", async (overrides, tone, label) => {
  const slot = await mount({
    recap: {
      ...WORKING,
      waitingAgents: [{ threadId: "thr_agent", task: "Run the suite" }],
    },
    threads: [sidebarThread("t1"), sidebarThread("thr_agent", overrides)],
  });
  const list = await slot.findByRole("list", { name: "Awaited agents" });
  const row = list.querySelector("li")!;
  expect(row.getAttribute("data-agent-status")).toBe(tone);
  expect(slot.getByLabelText("Agent status").textContent).toBe(label);
});

it("shows the Waiting goal as the title in the compact card", async () => {
  const slot = await mount({
    layout: "minimal",
    recap: { ...WORKING, goal: "Workers are running" },
  });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(
    slot.getByRole("heading", { name: /Workers are running/ }),
  ).toBeTruthy();
  expect(slot.queryByRole("heading", { name: "Building the card" })).toBeNull();
  expect(slot.getByLabelText("Status check countdown").textContent).toMatch(
    /^[01]:\d{2}$/,
  );
  expect(region.textContent).not.toContain("Inspect worker results");
  expect(slot.queryByRole("heading", { name: "Tasks" })).toBeNull();
});

it.each([
  ["without next actions", []],
  ["with next actions", ["Inspect the result"]],
])("keeps Archive at the right %s", async (_label, next) => {
  const slot = await mount({
    archivable: true,
    recap: { next },
  });
  const archive = await slot.findByRole("button", { name: "Archive" });
  expect(archive.className).toContain("ml-auto");
});

it("shows the goal, results, and an icon-only Archive in the compact complete card", async () => {
  const slot = await mount({ layout: "minimal", archivable: true });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(slot.getByRole("heading", { name: "Building the card" })).toBeTruthy();
  expect(progress(region)).toEqual(["done:Done: Card renders"]);
  const archive = await slot.findByRole("button", { name: "Archive" });
  expect(archive.textContent).toBe("");
  fireEvent.click(archive);
  await waitFor(() =>
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "archive",
      input: { threadId: "t1", recapId: "r1" },
    }),
  );
});

it("sets the card's text in BB's phone type tokens", async () => {
  const slot = await mount({
    layout: "minimal",
    archivable: true,
    recap: { state: "review", review: ["Open Settings"] },
  });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  const primary = (text: string) =>
    slot.getByText(text).closest('[class~="max-md:pointer-coarse:text-base"]');
  // On a phone the goal and the rows are `text-base`, the timeline's size,
  // rather than the card's fluid sizes.
  expect(primary("Building the card")).not.toBeNull();
  expect(primary("Open Settings")).not.toBeNull();
  // Small text follows BB's secondary token, and the corner buttons its
  // coarse-pointer icon-button size.
  expect(
    region.querySelector('[class~="max-md:pointer-coarse:text-xs"]'),
  ).not.toBeNull();
  expect(
    slot.getByRole("button", { name: "Dismiss recap" }).className,
  ).toContain("max-md:pointer-coarse:h-9");
});

it("shrinks the card's text on a very narrow pane only for a mouse", async () => {
  const slot = await mount({ layout: "minimal" });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  const scroller = region.querySelector(".thread-scrollbar")!;
  // A phone narrower than 20rem keeps BB's sizes: the 10px fallback is
  // gated on a fine pointer.
  expect(scroller.className).toContain(
    "@max-[20rem]/recap:pointer-fine:[&_*]:!text-[0.625rem]",
  );
  expect(scroller.className).not.toMatch(/recap:\[&_\*\]:!text/);
});

it("shows the goal and only the review steps in the compact review card", async () => {
  const slot = await mount({
    layout: "minimal",
    archivable: true,
    recap: { state: "review", review: ["Open Settings"] },
  });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(slot.getByRole("heading", { name: "Building the card" })).toBeTruthy();
  expect(region.textContent).toContain("Open Settings");
  expect(region.textContent).not.toContain("Card renders");
  expect(slot.queryByRole("heading", { name: "Review" })).toBeNull();
  expect(
    (await slot.findByRole("button", { name: "Archive" })).textContent,
  ).toBe("");
});

it("resolves inline recap file links from the thread workspace root", async () => {
  const slot = await mount({
    recap: {
      state: "review",
      review: [
        "Inspect [README.md](/work/README.md) and [the guide](docs/guide.md)",
      ],
    },
  });
  const markdowns = await slot.findAllByTestId("recap-markdown-document");
  const markdown = markdowns.find((element) =>
    element.textContent?.includes("Inspect [README.md]"),
  );
  expect(markdown).toBeDefined();
  expect(markdown!.getAttribute("data-thread-id")).toBe("t1");
  expect(markdown!.getAttribute("data-root-path")).toBe("/work");
  expect(JSON.parse(markdown!.getAttribute("data-target")!)).toEqual({
    kind: "workspace",
    environmentId: "env_1",
    path: "__recap__.md",
  });
});

it("shows UI review steps without artifact links", async () => {
  const slot = await mount({
    recap: {
      state: "review",
      review: [
        "Open Settings → Appearance and choose Dark; expect dark panels",
      ],
    },
  });
  await slot.findByRole("region", { name: "Latest recap" });
  expect(
    slot.getByText(
      "Open Settings → Appearance and choose Dark; expect dark panels",
    ),
  ).toBeTruthy();
  expect(slot.queryByRole("list", { name: "Links" })).toBeNull();
});

it("shows structured review steps with expected results", async () => {
  const slot = await mount({
    recap: {
      state: "review",
      review: [
        { step: "Open Appearance", expect: "Dark is available" },
        { step: "Reload Settings", expect: "Dark stays selected" },
      ],
    },
  });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.querySelectorAll("ol > li")).toHaveLength(2);
  expect(slot.queryByText("Expect")).toBeNull();
  expect(slot.getByText("Dark is available")).toBeTruthy();
  expect(slot.getByText("Dark stays selected")).toBeTruthy();
});

it.each(["full"])(
  "shows the review check, its links, and archive acceptance in %s",
  async (layout) => {
    const slot = await mount({
      layout,
      archivable: true,
      recap: {
        state: "review",
        review: [
          "Review the pull request, report, and notes; expect matching findings",
        ],
        links: [
          { title: "Pull request", location: "https://github.com/o/r/pull/1" },
          { title: "Report", location: "/work/report.md" },
          // Outside the workspace: still a link, through the host.
          { title: "Notes", location: "/tmp/notes.md" },
        ],
      },
    });
    const region = await slot.findByRole("region", { name: "Latest recap" });
    expect(region.textContent).toContain("Ready for Review");
    expect(slot.getByRole("heading", { name: "Review" })).toBeTruthy();
    // Links belong to the review row, not a section of their own.
    expect(slot.queryByRole("heading", { name: "Links" })).toBeNull();
    expect(
      slot
        .getByRole("list", { name: "Links" })
        .closest("section")
        ?.querySelector("h3")?.textContent,
    ).toBe("Review");
    expect(region.textContent).toContain(
      "Review the pull request, report, and notes; expect matching findings",
    );
    const reportLink = slot.getByText("Report").closest("a");
    const notesLink = slot.getByText("Notes").closest("a");
    const prLink = slot.getByText("Pull request").closest("a");
    expect(reportLink).toBeTruthy();
    expect(reportLink?.getAttribute("href")).toBe("./report.md");
    expect(notesLink).toBeTruthy();
    expect(notesLink?.getAttribute("href")).toBe("./%2Ftmp%2Fnotes.md");
    expect(prLink).toBeTruthy();
    expect(prLink?.getAttribute("href")).toBe("https://github.com/o/r/pull/1");

    fireEvent.click(reportLink!);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "experimental_openFilePreview",
      options: {
        target: {
          kind: "workspace",
          environmentId: "env_1",
          path: "report.md",
        },
        location: null,
      },
    });

    fireEvent.click(notesLink!);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "experimental_openFilePreview",
      options: {
        target: {
          kind: "host",
          hostId: "host_1",
          path: "/tmp/notes.md",
        },
        location: null,
      },
    });
    // One review step reads as plain text.
    expect(
      slot
        .getByText(
          "Review the pull request, report, and notes; expect matching findings",
        )
        .closest("li"),
    ).toBeNull();
    const archive = await slot.findByRole("button", { name: "Archive" });
    // Sized and styled like the suggested actions beside it.
    expect(archive.className).toContain("h-7");
    expect(archive.className).toContain("text-[11.5px]");
    expect(archive.className).toContain("border-border");
    fireEvent.click(archive);
    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "archive",
        input: { threadId: "t1", recapId: "r1" },
      }),
    );
  },
);

it("lists several review steps", async () => {
  const slot = await mount({
    recap: {
      state: "review",
      review: ["Open New work and type a request", "Expand Debug"],
    },
  });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  const steps = [...region.querySelectorAll("section")].find((section) =>
    section.textContent?.startsWith("Review"),
  )!;
  // Steps are numbered in order.
  expect([...steps.querySelectorAll("li")].map((li) => li.textContent)).toEqual(
    ["1.Open New work and type a request", "2.Expand Debug"],
  );
});

it("withdraws Archive once the user continues the thread", async () => {
  const slot = await mount({ archivable: true });
  await slot.findByRole("button", { name: "Archive" });
  await slot.setComposerText("One more thing");
  await waitFor(() =>
    expect(slot.queryByRole("button", { name: "Archive" })).toBeNull(),
  );
  // Clearing the draft doesn't bring it back for this recap.
  await slot.setComposerText("");
  expect(slot.getByRole("region", { name: "Latest recap" })).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Archive" })).toBeNull();
});

it("restores a dismissed recap without archiving", async () => {
  const slot = await mount({ archivable: true, recap: { id: "r2" } });
  fireEvent.click(await slot.findByRole("button", { name: "Dismiss recap" }));
  await waitFor(() =>
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "recap_dismiss",
      input: { threadId: "t1", recapId: "r2" },
    }),
  );
  await waitFor(() =>
    expect(slot.queryByRole("region", { name: "Latest recap" })).toBeNull(),
  );
  fireEvent.click(await slot.findByRole("button", { name: "Show recap" }));
  await waitFor(() =>
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "recap_restore",
      input: { threadId: "t1", recapId: "r2" },
    }),
  );
  expect(
    await slot.findByRole("region", { name: "Latest recap" }),
  ).toBeTruthy();
  expect(slot.inspection.rpcCalls.some((c) => c.method === "archive")).toBe(
    false,
  );
});

it("says so when the agent ran out of reminders without a recap", async () => {
  const slot = await mount({ recap: null, capped: true });
  expect(
    await slot.findByText(
      /No recap recorded\. Automatic continuation is paused/,
    ),
  ).toBeTruthy();
});

it("lets a live question card supersede the recap", async () => {
  const slot = await mount({ pendingThreadId: "t1" });
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "recap_get"),
    ).toBe(true),
  );
  expect(slot.queryByRole("region", { name: "Latest recap" })).toBeNull();
});

it("keeps the recap when only another thread needs input", async () => {
  const slot = await mount({ pendingThreadId: "other" });
  expect(
    await slot.findByRole("region", { name: "Latest recap" }),
  ).toBeTruthy();
});

it("hides on live input and restores the same recap when input clears", async () => {
  const slot = await mount();
  await slot.findByRole("region", { name: "Latest recap" });
  interactionOverride.value = true;
  await slot.setComposerText("Draft retained during input");
  expect(slot.queryByRole("region", { name: "Latest recap" })).toBeNull();
  interactionOverride.value = false;
  await slot.setComposerText("Draft retained after input");
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("Card renders");
});

it("stays up while the user drafts a message", async () => {
  const slot = await mount();
  await slot.findByRole("region", { name: "Latest recap" });
  await slot.setComposerText("About that recap, ");
  expect(slot.getByRole("region", { name: "Latest recap" })).toBeTruthy();
});

it("holds the card's space the moment sending hides it", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return {
        height: this.classList.contains("flow-root") ? 120 : 0,
      } as DOMRect;
    },
  );
  const slot = await mount();
  await slot.findByRole("region", { name: "Latest recap" });
  const heights: string[] = [];
  const observer = new MutationObserver(() => {
    const held = slot.container.querySelector<HTMLElement>(
      "[aria-hidden='true'].flow-root",
    );
    if (held) heights.push(held.style.height);
  });
  observer.observe(slot.container, { childList: true, subtree: true });
  sendingOverride.value = true;
  // Any composer update re-renders the card with the override applied.
  await slot.setComposerText("Next, ");
  observer.disconnect();
  expect(slot.queryByRole("region", { name: "Latest recap" })).toBeNull();
  // The slot arrived with the card's height, in place of the card.
  expect(heights[0]).toBe("120px");
  // Outside BB's thread scroller the slot goes once the card has dissolved.
  await waitFor(() =>
    expect(slot.container.querySelector("[aria-hidden='true']")).toBeNull(),
  );
});

it("renders commit hashes and thread mentions as chips", async () => {
  const slot = await mount({
    recap: { latest: ["Pushed cef48186269c for @thread:other"] },
  });
  await slot.findByRole("region", { name: "Latest recap" });
  const sha = slot.getByRole("button", { name: "Copy commit cef48186269c" });
  expect(sha.textContent).toBe("cef4818");
  expect(slot.getByRole("link").getAttribute("href")).toBe(
    "/projects/proj_1/threads/other",
  );
});

it("colors hash digits and letters from settings", async () => {
  const slot = await mount({
    hashDigits: "#112233",
    hashLetters: "#445566",
    recap: { latest: ["Pushed cef48186269c"] },
  });
  await slot.findByRole("region", { name: "Latest recap" });
  const sha = slot.getByRole("button", { name: "Copy commit cef48186269c" });
  expect(sha.style.color).toBe("rgb(17, 34, 51)");
  expect((sha.querySelector("span span") as HTMLElement).style.color).toBe(
    "rgb(68, 85, 102)",
  );
});

it("shows full sentence-case action labels and sends each message", async () => {
  const slot = await mount({
    recap: { next: ["Run the full test suite", "Open a pull request"] },
  });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  const list = slot.getByRole("list", { name: "Next actions" });
  expect(region.contains(list)).toBe(true);
  expect(
    slot.getByRole("button", { name: "Run the full test suite" }).textContent,
  ).toBe("Run the full test suite");
  expect(list.textContent).toContain("Run the full test suite");
  expect(list.textContent).toContain("Open a pull request");
  expect(slot.queryByRole("button", { name: "Archive" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Open a pull request" }));
  await waitFor(() =>
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "recap_send",
      input: {
        threadId: "t1",
        recapId: "r1",
        action: "Open a pull request",
      },
    }),
  );
  expect(
    slot.inspection.rpcCalls.find((c) => c.method === "recap_send")?.input,
  ).toMatchObject({ action: "Open a pull request" });
});

it("Shift-clicks a suggested action into the composer without sending", async () => {
  const slot = await mount({
    composer: { text: "Already drafting: " },
    recap: {
      next: [
        {
          title: "Run tests",
          message: "Run the full test suite and summarize failures",
        },
      ],
    },
  });
  const button = await slot.findByRole("button", { name: "Run tests" });
  fireEvent.click(button, { shiftKey: true });

  expect(slot.inspection.composer.text).toBe(
    "Already drafting: Run the full test suite and summarize failures",
  );
  expect(slot.inspection.composer.focusCount).toBe(1);
  expect(
    slot.inspection.rpcCalls.some((call) => call.method === "recap_send"),
  ).toBe(false);
});

it("sends a suggested action on an ordinary click", async () => {
  const slot = await mount({ recap: { next: ["Run the full test suite"] } });
  fireEvent.click(
    await slot.findByRole("button", { name: "Run the full test suite" }),
  );
  await waitFor(() =>
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "recap_send",
      input: {
        threadId: "t1",
        recapId: "r1",
        action: "Run the full test suite",
      },
    }),
  );
});

it("shows a short sentence-case action label with neutral styling", async () => {
  stubResizeObserver();
  const slot = await mount({
    recap: {
      next: [
        {
          title: "Run tests",
          message: "Run the full test suite and summarize failures",
          description: "Check for regressions before shipping",
        },
      ],
    },
  });
  await slot.findByRole("region", { name: "Latest recap" });
  const button = slot.getByRole("button", { name: "Run tests" });
  expect(button.textContent).toBe("Run tests");
  expect(button.className).toContain("text-foreground");
  expect(button.className).not.toContain("text-emerald-700");
  expect(button.className).toContain("border-border");
  expect(button.className).toContain("bg-transparent");
  expect(button.getAttribute("aria-description")).toBeNull();
  fireEvent.pointerMove(button, {
    pointerType: "mouse",
    pointerX: 1,
    pointerY: 1,
  });
  const hint = await slot.findByRole("tooltip", {}, { timeout: 1500 });
  expect(hint.textContent).toContain("Check for regressions before shipping");
  expect(hint.textContent).toContain("Click to send");
  expect(hint.textContent).toContain("click to edit");
  expect(hint.querySelector('kbd[aria-label="Shift"]')).toBeTruthy();
  fireEvent.click(button);
  await waitFor(() =>
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "recap_send",
      input: {
        threadId: "t1",
        recapId: "r1",
        action: "Run the full test suite and summarize failures",
      },
    }),
  );
});

it("teaches click and Shift-click on an action without a description", async () => {
  stubResizeObserver();
  const slot = await mount({ recap: { next: ["Summarize changes"] } });
  const button = await slot.findByRole("button", { name: "Summarize changes" });
  fireEvent.pointerMove(button, {
    pointerType: "mouse",
    pointerX: 1,
    pointerY: 1,
  });
  const hint = await slot.findByRole("tooltip", {}, { timeout: 1500 });
  expect(hint.textContent).toBe("Click to send\u00b7\u21e7click to edit");
});

it("explains a titled action without a description by the message it sends", async () => {
  stubResizeObserver();
  const slot = await mount({
    recap: {
      next: [{ title: "Run tests", message: "Run the full test suite" }],
    },
  });
  const button = await slot.findByRole("button", { name: "Run tests" });
  fireEvent.pointerMove(button, {
    pointerType: "mouse",
    pointerX: 1,
    pointerY: 1,
  });
  const hint = await slot.findByRole("tooltip", {}, { timeout: 1500 });
  expect(hint.textContent).toContain("Run the full test suite");
});

it("edits an overflow action into the composer without sending", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("basis-0") ? 80 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-next-actions-measure") ? 240 : 0;
    },
  );
  const slot = await mount({
    composer: { text: "Please " },
    recap: { next: ["Review the diff"] },
  });
  await slot.findByRole("region", { name: "Latest recap" });
  fireEvent(window, new Event("resize"));
  const trigger = await slot.findByRole("button", { name: "Next actions" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(
    await slot.findByRole("menuitem", { name: "Edit in composer" }),
  );

  expect(slot.inspection.composer.text).toBe("Please Review the diff");
  expect(slot.inspection.composer.focusCount).toBe(1);
  expect(
    slot.inspection.rpcCalls.some((call) => call.method === "recap_send"),
  ).toBe(false);
});

it("collapses wrapping action buttons into a menu", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("basis-0") ? 80 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-next-actions-measure") ? 240 : 0;
    },
  );
  const slot = await mount({
    recap: {
      next: [
        {
          title: "Run tests",
          message: "Run the full test suite",
          description: "Check for regressions",
        },
        {
          title: "Open pull request",
          message: "Open a pull request for the change",
        },
      ],
    },
  });
  await slot.findByRole("region", { name: "Latest recap" });
  fireEvent(window, new Event("resize"));
  const trigger = await slot.findByRole("button", { name: "Next actions" });
  expect(trigger.className).toContain("text-foreground");
  expect(trigger.textContent).toContain("Next actions");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const item = await slot.findByRole("menuitem", { name: /Run tests/ });
  expect(item.textContent).toContain("Check for regressions");
  fireEvent.click(item);
  await waitFor(() =>
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "recap_send",
      input: {
        threadId: "t1",
        recapId: "r1",
        action: "Run the full test suite",
      },
    }),
  );
});

it("sends no next actions for a waiting recap", async () => {
  const slot = await mount({
    recap: {
      state: "waiting",
      goal: "Running tests",
      timeout: 60,
      latest: [],
    },
  });
  await slot.findByRole("region", { name: "Latest recap" });
  expect(slot.queryByRole("list", { name: "Next actions" })).toBeNull();
});

it("keeps the other next action buttons idle while one is sending", async () => {
  let resolve!: (value: { ok: boolean }) => void;
  const sent = new Promise<{ ok: boolean }>((done) => {
    resolve = done;
  });
  const slot = await mount({
    recap: { next: ["Run the full test suite", "Open a pull request"] },
    send: () => sent,
  });
  await slot.findByRole("region", { name: "Latest recap" });
  fireEvent.click(
    slot.getByRole("button", { name: "Run the full test suite" }),
  );
  await waitFor(() =>
    expect(
      slot
        .getByRole("button", { name: "Open a pull request" })
        .getAttribute("disabled"),
    ).not.toBeNull(),
  );
  resolve({ ok: true });
  await waitFor(() =>
    expect(
      slot
        .getByRole("button", { name: "Open a pull request" })
        .getAttribute("disabled"),
    ).toBeNull(),
  );
});
