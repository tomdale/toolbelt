// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState } from "./fixtures.ts";

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
  cleanup();
  vi.restoreAllMocks();
});

const SUMMARY =
  "Goal: Building the card.\nLatest: Card renders\nOpen: Add layouts\nDone: Ported styles";

async function mount(options: {
  settings?: Record<string, string | boolean>;
  recap?: string | null;
  needsInput?: string | null;
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
        state: () => emptyState(),
        archiveStatus: () => ({ revision: null }),
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

it("shows what the thread needs from the user", async () => {
  const slot = await mount({ needsInput: "Pick A or B" });
  const region = await slot.findByRole("region", { name: "Latest recap" });
  expect(region.textContent).toContain("For you");
  expect(region.textContent).toContain("Pick A or B");
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

it("offers Generate Recap after the recap is dismissed", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return {
        height: this.classList.contains("flow-root") ? 120 : 0,
      } as DOMRect;
    },
  );
  const slot = await mount({});
  await slot.findByRole("region", { name: "Latest recap" });
  // The dismissed card eases out in its slot while the button fades in below.
  let together = false;
  const observer = new MutationObserver(() => {
    const held = slot.container.querySelector('[aria-hidden="true"].flow-root');
    const fading = slot.container.querySelector(".ws-fade-in");
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
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "recap_generate"),
    ).toBe(true),
  );
});
