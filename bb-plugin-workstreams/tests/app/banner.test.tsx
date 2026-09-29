// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState } from "./fixtures.ts";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const proposal = (status: string, text: string) => ({
  id: "p1",
  kind: "spin-out",
  status,
  subject: "BB Recap",
  sourceSectionId: "sec_a",
  sourceName: "BB & plugins",
  targetSectionId: status === "pending" ? null : "sec_new",
  targetName: "BB Recap",
  threadIds: ["t1", "t2", "t3"],
  entryId: "e1",
  acknowledged: false,
  text,
  accept: "Spin out",
  updatedAt: 1,
});
const PENDING =
  "This thread and 2 others look like BB Recap work. Spin out a BB Recap workstream?";

async function mount(
  status: "pending" | "applied",
  { compact = false, threadId = "t1" } = {},
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const slot = app.threadHeaderActions.find(
    (a) => a.id === "workstream-proposal",
  )!;
  return renderSlot(
    slot,
    { threadId, projectId: "proj_1", isCompactViewport: compact },
    {
      rpc: {
        state: () => ({
          ...emptyState(),
          proposals: [
            proposal(
              status,
              status === "pending"
                ? PENDING
                : "Moved from BB & plugins → BB Recap",
            ),
          ],
        }),
        proposal: () => ({ ok: true }),
        undo: () => ({ entry: {} }),
      },
    },
  );
}

it("shows the pending proposal as a pill and a floating banner", async () => {
  const slot = await mount("pending");
  const pill = await slot.findByRole("button", { name: /Show proposal/ });
  expect(pill.textContent).toBe("✦ BB Recap?");
  const banner = await waitFor(() => {
    const el = document.querySelector("[data-workstreams-banner]");
    if (!el) throw new Error("no banner");
    return el as HTMLElement;
  });
  expect(banner.textContent).toContain(PENDING);
  expect(
    [...banner.querySelectorAll("button")].map((b) => b.textContent),
  ).toEqual(["Spin out", "Review…", "Not now"]);
  // Never steals focus.
  expect(banner.contains(document.activeElement)).toBe(false);
  fireEvent.click(banner.querySelector("button")!);
  await waitFor(() =>
    expect(slot.inspection.rpcCalls.some((c) => c.method === "proposal")).toBe(
      true,
    ),
  );
  const call = slot.inspection.rpcCalls.find((c) => c.method === "proposal")!;
  expect(call.input).toEqual({ id: "p1", action: "accept" });
  slot.lifecycle.unmount();
});

it("collapses to the pill, and shows only the pill on phones", async () => {
  const slot = await mount("pending");
  const pill = await slot.findByRole("button", { name: /Show proposal/ });
  await waitFor(() =>
    expect(document.querySelector("[data-workstreams-banner]")).not.toBeNull(),
  );
  fireEvent.click(pill);
  expect(document.querySelector("[data-workstreams-banner]")).toBeNull();
  slot.lifecycle.unmount();

  const phone = await mount("pending", { compact: true });
  await phone.findByRole("button", { name: /Show proposal/ });
  expect(document.querySelector("[data-workstreams-banner]")).toBeNull();
  phone.lifecycle.unmount();
});

it("offers Undo and OK once applied, and hides for unaffected threads", async () => {
  const slot = await mount("applied");
  await slot.findByRole("button", { name: /Show change/ });
  const banner = await waitFor(() => {
    const el = document.querySelector("[data-workstreams-banner]");
    if (!el) throw new Error("no banner");
    return el as HTMLElement;
  });
  expect(banner.textContent).toContain("Moved from BB & plugins → BB Recap");
  expect(
    [...banner.querySelectorAll("button")].map((b) => b.textContent),
  ).toEqual(["Undo", "OK"]);
  slot.lifecycle.unmount();

  const other = await mount("applied", { threadId: "elsewhere" });
  await new Promise((r) => setTimeout(r, 20));
  expect(other.queryByRole("button")).toBeNull();
  other.lifecycle.unmount();
});
