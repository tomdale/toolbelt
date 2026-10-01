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
  return {
    ...actual,
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
};

async function mount(
  options: {
    layout?: string;
    recap?: Record<string, unknown> | null;
    capped?: boolean;
    archivable?: boolean;
    pendingThreadId?: string;
  } = {},
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const banner = app.composerCustomizations.find((c) => c.id === "recap")!
    .banners![0]!;
  let recap =
    options.recap === null ? null : { ...RECAP, ...(options.recap ?? {}) };
  let dismissed = false;
  return renderSlot(
    banner,
    {},
    {
      composer: { scope: { kind: "thread", threadId: "t1" } },
      sidebarThreads: {
        threads: [
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
          },
        }),
        state: () => emptyState(),
        archiveStatus: () => ({
          recapId: options.archivable ? (recap?.id ?? null) : null,
        }),
        archive: () => ({ ok: true }),
        recap_get: () => ({
          recap,
          dismissed,
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
      },
    },
  );
}

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

it("drops the goal heading in the minimal layout", async () => {
  const slot = await mount({ layout: "minimal" });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).not.toContain("Building the card");
  expect(region.textContent).toContain("Card renders");
});

it.each(["full", "minimal"])(
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
    // A compact outline button in every layout, so it never outweighs the recap.
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
  expect(await slot.findByText(/No recap after 3 reminders/)).toBeTruthy();
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
