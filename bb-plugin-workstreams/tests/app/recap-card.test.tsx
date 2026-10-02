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
});

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
    hashDigits?: string;
    hashLetters?: string;
    recap?: Record<string, unknown> | null;
    capped?: boolean;
    archivable?: boolean;
    pendingThreadId?: string;
    threads?: ReturnType<typeof sidebarThread>[];
    archive?: () => { ok: boolean } | Promise<{ ok: boolean }>;
    send?: (input: unknown) => { ok: boolean } | Promise<{ ok: boolean }>;
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
      composer: { scope: { kind: "thread", threadId: "t1" } },
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
        recap_cancel_waiting: () => {
          waitingCancelled = true;
          return { ok: true };
        },
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

it("renders the waiting task as a linked title", async () => {
  const slot = await mount({
    threads: [
      sidebarThread("t1"),
      sidebarThread("thr_tests", { title: "Test worker" }),
    ],
    recap: {
      state: "waiting",
      task: "Running tests with @thread:thr_tests",
      timeout: 60,
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
  task: "Workers and tests are running",
  timeout: 60,
  at: Date.now(),
  latest: [],
};
const progress = (region: HTMLElement) =>
  [...region.querySelectorAll("li[data-progress]")].map(
    (li) => `${li.getAttribute("data-progress")}:${li.textContent}`,
  );

it("shows the task title with countdown and cancel beside it", async () => {
  const slot = await mount({ recap: WORKING });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("Waiting");
  const countdown = slot.getByLabelText("Status check countdown");
  expect(countdown.textContent).toMatch(/^[01]:\d{2}$/);
  const taskHeading = slot.getByRole("heading", {
    name: /Workers and tests are running/,
  });
  expect(taskHeading.parentElement?.contains(countdown)).toBe(true);
  const cancel = slot.getByRole("button", { name: "Cancel status check" });
  expect(cancel.textContent).toBe("");
  expect(cancel.querySelector('[data-icon="ClockArrowDown"]')).toBeTruthy();
  expect(cancel.className).toContain("size-5");
  expect(region.querySelector("[data-icon='LoaderCircle']")).toBeNull();
  expect(slot.queryByRole("heading", { name: "Tasks" })).toBeNull();
  expect(taskHeading).toBeTruthy();
  expect(slot.queryByRole("heading", { name: "Next" })).toBeNull();
  expect(region.querySelector('[data-progress="done"]')).toBeNull();
  expect(slot.queryByRole("heading", { name: "Review" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Archive" })).toBeNull();
});

it.each(["full", "minimal"])(
  "uses a single waiting task as the title without showing the goal (%s)",
  async (layout) => {
    const slot = await mount({
      layout,
      recap: {
        ...WORKING,
        goal: "Waiting for background jobs",
        task: "Build the release",
      },
    });
    await slot.findByRole("region", { name: "Latest recap" });
    const taskHeading = slot.getByRole("heading", {
      name: "Build the release",
    });
    expect(taskHeading).toBeTruthy();
    expect(
      taskHeading.querySelector("[data-testid='bb-markdown']")?.className,
    ).toContain(layout === "minimal" ? "0.6875rem" : "0.8125rem");
    expect(
      slot.queryByRole("heading", { name: "Waiting for background jobs" }),
    ).toBeNull();
    expect(slot.getByLabelText("Status check countdown").textContent).toMatch(
      /^[01]:\d{2}$/,
    );
  },
);

it.each(["full", "minimal"])(
  "renders a task and linked thread on separate lines and cancels without dismissing (%s)",
  async (layout) => {
    const slot = await mount({
      layout,
      threads: [
        sidebarThread("t1"),
        sidebarThread("thr_abc123def", { title: "Test worker" }),
      ],
      recap: {
        ...WORKING,
        task: "Testing while @thread:thr_abc123def runs",
      },
    });
    const region = await slot.findByRole("region", { name: "Latest recap" });
    expect(region.textContent).toContain("Testing");
    const mention = await slot.findByText("Test worker");
    const countdown = slot.getByLabelText("Status check countdown");
    const task = region.querySelector('[data-progress="active"]')!;
    expect(task.contains(mention)).toBe(true);
    expect(task.contains(countdown)).toBe(true);
    expect(task.textContent).toContain("Testing");
    expect(task.textContent).toContain(countdown.textContent);
    expect(
      slot.getByRole("button", { name: "Cancel status check" }).textContent,
    ).toBe("");
    expect(
      slot
        .getByRole("button", { name: "Cancel status check" })
        .querySelector('[data-icon="ClockArrowDown"]'),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Cancel status check" }));
    await waitFor(() =>
      expect(region.textContent).toContain("Status check cancelled"),
    );
    expect(region.textContent).toContain("Testing");
    expect(slot.queryByRole("button", { name: "Dismiss recap" })).toBeTruthy();
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "recap_cancel_waiting",
      input: { threadId: "t1", recapId: "r1" },
    });
    expect(
      slot.queryByRole("button", { name: "Cancel status check" }),
    ).toBeNull();
  },
);

it("shows the single task as the title in the compact waiting card", async () => {
  const slot = await mount({
    layout: "minimal",
    recap: { ...WORKING, task: "Workers are running" },
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
    expect(slot.getByText("Pull request").closest("a")).toBeTruthy();
    expect(slot.getByText("Report").closest("a")).toBeTruthy();
    expect(slot.getByText("Notes").closest("a")).toBeTruthy();
    // One review step reads as plain text.
    expect(
      slot
        .getByText(
          "Review the pull request, report, and notes; expect matching findings",
        )
        .closest("li"),
    ).toBeNull();
    const archive = await slot.findByRole("button", { name: "Archive" });
    // A small outline button, so it never outweighs the recap.
    expect(archive.className).toContain("h-8");
    expect(archive.className).toContain("border-input");
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

it("shows a short sentence-case label with neutral styling", async () => {
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
  expect(button.getAttribute("title")).toBe(
    "Check for regressions before shipping",
  );
  expect(button.getAttribute("title")).not.toBe(
    "Run the full test suite and summarize failures",
  );
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
      task: "Running tests",
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
