// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, sidebarThread } from "./fixtures.ts";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

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

/**
 * BB's thread pane reduced to what the heading attaches to: the sliding app
 * surface, the pane with its title bar, the message scroller with its column,
 * and the composer, whose recap card scrolls its own text with the same class.
 */
function paneFixture({ recap }: { recap: boolean }) {
  document.body.innerHTML = `
    <main data-sidebar="inset">
      <div data-split-pane-id="main">
        <header>
          <div class="flex-1"><span class="bb-thread-title">Thread</span></div>
          <div>actions</div>
        </header>
        <div data-thread-window>
          <div class="thread-scrollbar" data-test="messages">
            <div><div data-test="column"></div></div>
          </div>
          <div data-app-composer>
            ${
              recap
                ? '<div role="region" aria-label="Latest recap"><div class="thread-scrollbar"></div></div>'
                : ""
            }
          </div>
        </div>
      </div>
    </main>`;
}

async function mountHeading() {
  stubResizeObserver();
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const heading = app.appOverlays.find(
    (overlay) => overlay.id === "sticky-thread-goal",
  )!;
  return renderSlot(
    heading,
    {},
    {
      context: { threadId: "t1", projectId: "proj_1" },
      sidebarThreads: {
        sections: [],
        threads: [sidebarThread("t1", { title: "Ship the mobile polish" })],
      },
      rpc: { state: () => emptyState() },
    },
  );
}

const root = () => document.querySelector("[data-workstreams-sticky-goal]");
const overlay = () => document.querySelector("[data-workstreams-goal-overlay]");

it("attaches to the message scroller although a recap card scrolls its own text", async () => {
  paneFixture({ recap: true });
  const slot = await mountHeading();
  await waitFor(() => expect(root()).not.toBeNull());
  expect(document.querySelector('[data-test="column"]')!.contains(root())).toBe(
    true,
  );
  slot.lifecycle.unmount();
});

it("draws the heading text inside the app's sliding surface so it travels with the pane", async () => {
  paneFixture({ recap: false });
  const slot = await mountHeading();
  await waitFor(() => expect(overlay()).not.toBeNull());
  expect(
    document.querySelector('[data-sidebar="inset"]')!.contains(overlay()),
  ).toBe(true);
  await waitFor(() =>
    expect(overlay()!.textContent).toContain("Ship the mobile polish"),
  );
  slot.lifecycle.unmount();
});

it("falls back to the body when the sliding surface is missing", async () => {
  paneFixture({ recap: false });
  document.querySelector("main")!.removeAttribute("data-sidebar");
  const slot = await mountHeading();
  await waitFor(() => expect(overlay()).not.toBeNull());
  expect(overlay()!.parentElement).toBe(document.body);
  slot.lifecycle.unmount();
});
