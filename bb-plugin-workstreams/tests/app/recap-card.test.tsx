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

const SUMMARY =
  "Goal: Building the card.\nLatest: Card renders\nOpen: Add layouts\nDone: Ported styles";

async function mount(options: {
  settings?: Record<string, string | boolean>;
  recap?: string | null;
  needsInput?: string | null;
  archiveRevision?: number;
  pendingThreadId?: string;
  generate?: () => unknown;
  get?: () => unknown;
}) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const banner = app.composerCustomizations.find((c) => c.id === "recap")!
    .banners![0]!;
  const recap =
    options.recap === null
      ? null
      : {
          threadId: "t1",
          summary: options.recap ?? SUMMARY,
          generatedAt: 1,
          turns: 3,
          model: "m",
        };
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
            automatic: options.settings?.recapAutomatic !== false,
            layout:
              (options.settings?.recapLayout as string | undefined) ??
              "detailed",
            quietSeconds: 30,
            minTurns: 3,
          },
        }),
        state: () => ({
          ...emptyState(),
          analysis: options.archiveRevision
            ? {
                t1: {
                  revision: options.archiveRevision,
                  state: "review",
                  recap: "Ready to review",
                  needsYou: null,
                  subject: null,
                  drift: null,
                  title: null,
                },
              }
            : {},
        }),
        archiveStatus: () => ({ revision: options.archiveRevision ?? null }),
        archiveSuggestion: () => ({ ok: true }),
        recap_get:
          options.get ??
          (() => ({
            recap,
            generating: false,
            needsInput: options.needsInput ?? null,
          })),
        recap_generate:
          options.generate ??
          (() => ({ recap, generated: true, reason: null })),
      },
    },
  );
}

it("renders the detailed layout by default", async () => {
  const slot = await mount({});
  const region = await slot.findByRole("region", { name: "Latest recap" });
  for (const text of [
    "Building the card.",
    "Card renders",
    "Add layouts",
    "Ported styles",
  ])
    expect(region.textContent).toContain(text);
});

it("drops Open and Done in the compact layout, and the goal in minimal", async () => {
  const compact = await mount({ settings: { recapLayout: "compact" } });
  const region = await compact.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("Building the card.");
  expect(region.textContent).not.toContain("Add layouts");
  compact.lifecycle.unmount();
  const minimal = await mount({ settings: { recapLayout: "minimal" } });
  const small = await minimal.findByRole("region", { name: "Latest recap" });
  expect(small.textContent).not.toContain("Building the card.");
  expect(small.textContent).toContain("Card renders");
});

it.each(["detailed", "compact", "minimal"])(
  "keeps the review check and archive acceptance visible in %s",
  async (layout) => {
    const slot = await mount({
      settings: { recapLayout: layout },
      recap:
        "Goal: Filtering recent threads\nLatest: Filter deployed\nReview: Open Recent; confirm only top-level threads appear\nDone: Tests passed",
      archiveRevision: 500,
    });
    const region = await slot.findByRole("region", { name: "Latest recap" });
    expect(region.textContent).toContain(
      "Open Recent; confirm only top-level threads appear",
    );
    const archive = await slot.findByRole("button", { name: "Archive thread" });
    fireEvent.click(archive);
    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "archiveSuggestion",
        input: { threadId: "t1", revision: 500, action: "archive" },
      }),
    );
  },
);

it("withdraws review acceptance when the user continues working", async () => {
  const slot = await mount({ archiveRevision: 500 });
  await slot.findByRole("button", { name: "Archive thread" });
  sendingOverride.value = true;
  await slot.setComposerText("Continue reviewing");
  await waitFor(() =>
    expect(slot.queryByRole("button", { name: "Archive thread" })).toBeNull(),
  );
  await waitFor(() =>
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "archiveSuggestion",
      input: { threadId: "t1", revision: 500, action: "dismiss" },
    }),
  );
});

it("shows what the thread needs from the user", async () => {
  const slot = await mount({ needsInput: "Pick A or B" });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("For you");
  expect(region.textContent).toContain("Pick A or B");
});

it("lets a live interaction supersede the recap even while idle", async () => {
  const slot = await mount({
    pendingThreadId: "t1",
    needsInput: "Pick A or B",
  });
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "recap_get"),
    ).toBe(true),
  );
  expect(slot.queryByRole("region", { name: "Latest recap" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Generate Recap" })).toBeNull();
});

it("keeps the recap when only another thread needs input", async () => {
  const slot = await mount({
    pendingThreadId: "other",
    needsInput: "Pick A or B",
  });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("Pick A or B");
});

it("hides on live input and restores the same recap when input clears", async () => {
  const slot = await mount({ needsInput: "Pick A or B" });
  await slot.findByRole("region", { name: "Latest recap" });
  interactionOverride.value = true;
  await slot.setComposerText("Draft retained during input");
  expect(slot.queryByRole("region", { name: "Latest recap" })).toBeNull();
  interactionOverride.value = false;
  await slot.setComposerText("Draft retained after input");
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("Pick A or B");
});

it("does not offer recap generation during pending input", async () => {
  const slot = await mount({ pendingThreadId: "t1", recap: null });
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "recap_get"),
    ).toBe(true),
  );
  expect(slot.queryByRole("button", { name: "Generate Recap" })).toBeNull();
});

it("hides the generating placeholder during pending input", async () => {
  const slot = await mount({
    pendingThreadId: "t1",
    recap: null,
    get: () => ({ recap: null, generating: true, needsInput: null }),
  });
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "recap_get"),
    ).toBe(true),
  );
  expect(slot.queryByRole("status", { name: "Generating recap" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Generate Recap" })).toBeNull();
});

it("offers Generate Recap when automatic recaps are off", async () => {
  const slot = await mount({
    settings: { recapAutomatic: false },
    recap: null,
  });
  fireEvent.click(await slot.findByRole("button", { name: "Generate Recap" }));
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "recap_generate"),
    ).toBe(true),
  );
});

it("drops an Open item that repeats the For you ask", async () => {
  const slot = await mount({
    recap:
      "Goal: Building.\nLatest: Done a thing\nOpen: Pick A or B?\nOpen: Write docs",
    needsInput: "Pick A or B?",
  });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent?.match(/Pick A or B\?/g)).toHaveLength(1);
  expect(region.textContent).toContain("Write docs");
});

it("stays up while the user drafts a message", async () => {
  const slot = await mount({});
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
  const slot = await mount({});
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

it("resizes the generating card into the recap rather than replacing it", async () => {
  let generating = true;
  const slot = await mount({
    settings: { recapAutomatic: false },
    get: () =>
      generating
        ? { recap: null, generating: true, needsInput: null }
        : {
            recap: {
              threadId: "t1",
              summary: SUMMARY,
              generatedAt: 1,
              turns: 3,
              model: "m",
            },
            generating: false,
            needsInput: null,
          },
  });
  const skeleton = await slot.findByRole("status", {
    name: "Generating recap",
  });
  generating = false;
  await slot.emitRealtime("changed", {});
  // The same element carries the recap, so it can ease to the new size.
  expect(await slot.findByRole("region", { name: "Latest recap" })).toBe(
    skeleton,
  );
});

it("keeps the dismissed card's space while Generate Recap fades in below", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const height = this.classList.contains("flow-root")
        ? 120
        : this.classList.contains("ws-fade-in")
          ? 40
          : 0;
      return { height } as DOMRect;
    },
  );
  // jsdom resolves Tailwind's classes to no style, so give the button's
  // wrapper the bottom margin it has in BB.
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    return element instanceof HTMLElement &&
      element.classList.contains("ws-fade-in")
      ? ({
          ...style,
          marginTop: "0px",
          marginBottom: "12px",
        } as CSSStyleDeclaration)
      : style;
  });
  const slot = await mount({});
  await slot.findByRole("region", { name: "Latest recap" });
  // The dismissed card eases out in its slot while the button fades in
  // below, and the slot gives the button its share of the space at once.
  let together = false;
  const heights: string[] = [];
  const observer = new MutationObserver(() => {
    const held = slot.container.querySelector<HTMLElement>(
      '[aria-hidden="true"].flow-root',
    );
    const fading = slot.container.querySelector(".ws-fade-in");
    if (held) heights.push(held.style.height);
    if (
      held &&
      fading &&
      held.compareDocumentPosition(fading) & Node.DOCUMENT_POSITION_FOLLOWING
    )
      together = true;
  });
  observer.observe(slot.container, {
    subtree: true,
    childList: true,
    attributes: true,
  });
  fireEvent.click(slot.getByRole("button", { name: "Dismiss recap" }));
  const button = await slot.findByRole("button", { name: "Generate Recap" });
  observer.disconnect();
  expect(together).toBe(true);
  // 120 held, minus the 40px button and its 12px margin.
  expect(heights).toContain("68px");
  expect(heights).not.toContain("0px");
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "recap_generate"),
    ).toBe(true),
  );
});

it("shows the generating card as soon as Generate Recap is pressed", async () => {
  let finish: (value: unknown) => void = () => {};
  const slot = await mount({
    generate: () => new Promise((resolve) => (finish = resolve)),
  });
  await slot.findByRole("region", { name: "Latest recap" });
  fireEvent.click(slot.getByRole("button", { name: "Dismiss recap" }));
  fireEvent.click(await slot.findByRole("button", { name: "Generate Recap" }));
  expect(
    await slot.findByRole("status", { name: "Generating recap" }),
  ).toBeTruthy();
  finish({ recap: null, generated: false, reason: "not_generated" });
});
