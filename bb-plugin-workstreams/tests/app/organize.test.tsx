// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { LiveOrganization } from "../../src/server/contract.ts";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const emptyCounts = {
  activeRoots: 0,
  completedRoots: 0,
  totalRoots: 0,
  unresolvedRoots: 0,
  activeWorkstreams: 0,
};

const snapshot = (error: string | null, status: LiveOrganization["status"] = "failed"): LiveOrganization => ({
  status,
  progress: null,
  error,
  lastUpdatedAt: 1,
  groups: [],
  unresolved: [],
  counts: emptyCounts,
});

type RpcResult = { state: LiveOrganization };

async function mount(organization: (input: unknown) => Promise<RpcResult>) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  return renderSlot(
    app.navPanels[0]!,
    { subPath: "map" },
    {
      sidebarThreads: {
        status: "ready",
        threads: [],
        sections: [],
        projects: [],
      },
      rpc: { state: () => ({ state: null }), organization },
    },
  );
}

describe("Organize view", () => {
  it("shows classification progress during classifying state", async () => {
    const progress: LiveOrganization = {
      status: "classifying",
      progress: {
        stage: "classifying",
        completed: 4,
        total: 12,
        cached: 3,
        unresolved: 1,
      },
      error: null,
      lastUpdatedAt: 1,
      groups: [],
      unresolved: [],
      counts: emptyCounts,
    };

    const slot = await mount(async () => ({ state: progress }));
    const bar = await slot.findByRole("progressbar", {
      name: "Classifying tasks 4 of 12",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("33");
    expect(slot.getByText("3 already classified · 1 unresolved")).toBeTruthy();
  });

  it("shows error alert when status is failed", async () => {
    const failed = snapshot("Model gateway timeout", "failed");
    const slot = await mount(async () => ({ state: failed }));
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toContain("Model gateway timeout"),
    );
  });

  it("renders derived workstreams when status is idle", async () => {
    const idleState: LiveOrganization = {
      status: "idle",
      progress: null,
      error: null,
      lastUpdatedAt: 100,
      groups: [
        {
          key: "sec_a",
          sectionId: "sec_a",
          name: "Alpha",
          description: "Alpha work",
          activeCount: 1,
          completedCount: 0,
          totalCount: 1,
          roots: [
            {
              id: "t1",
              title: "Task 1",
              completed: false,
              identityId: "sec_a",
              identityLabel: "Platform · Alpha",
              provenance: "automatic",
              reason: "Classified as Alpha.",
            },
          ],
        },
      ],
      unresolved: [],
      counts: {
        activeRoots: 1,
        completedRoots: 0,
        totalRoots: 1,
        unresolvedRoots: 0,
        activeWorkstreams: 1,
      },
    };

    const slot = await mount(async () => ({ state: idleState }));
    await waitFor(() =>
      expect(
        slot.getByText(
          "All tasks are already in their recommended workstreams. Nothing changes until you apply.",
        ),
      ).toBeTruthy(),
    );
    // Expand Alpha group
    fireEvent.click(slot.getByRole("button", { name: /^Alpha/ }));
    expect(await slot.findByText("Platform · Alpha")).toBeTruthy();
  });
});
