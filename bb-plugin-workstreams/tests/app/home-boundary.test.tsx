// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { mountHome, sidebarThread } from "./home-mount.tsx";

vi.mock("../../src/app/useWorkstreams.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/useWorkstreams.ts")>()),
  useWorkstreams: () => {
    throw new Error("projection exploded");
  },
}));

afterEach(cleanup);

it("steps aside, leaving BB's Recent list, when the screen throws", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const slot = await mountHome({
    threads: [sidebarThread("a", { sectionId: "sec_a" })],
  });
  await waitFor(() =>
    expect(
      slot.container
        .querySelector("[data-ws-home]")
        ?.getAttribute("data-ws-home"),
    ).toBe("hidden"),
  );
  // The failure is contained: BB's own slot boundary never sees it.
  expect(slot.container.textContent).not.toContain("crashed");
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("Recent list stays"),
    expect.any(Error),
  );
  warn.mockRestore();
  error.mockRestore();
});
