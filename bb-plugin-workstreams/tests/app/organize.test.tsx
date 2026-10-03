// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { Organize } from "../../src/app/page/Organize.tsx";
import type { BootstrapState } from "../../src/server/bootstrap.ts";

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

const snapshot = (error: string | null, startedAt: number) => ({
  status: "failed",
  startedAt,
  updatedAt: startedAt,
  error,
  roots: [],
  descriptions: {},
  changes: [],
  preview: null,
  seconds: { intake: 0, map: 0, assign: 0, apply: 0 },
  traceIds: [],
});

type RpcResult = { state: BootstrapState | ReturnType<typeof snapshot> | null };

async function mount(bootstrap: (input: unknown) => Promise<RpcResult>) {
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
      rpc: { state: () => ({ state: null }), bootstrap },
    },
  );
}

describe("Organize request freshness", () => {
  it("shows classification progress and leaves Cancel enabled during a long start call", async () => {
    const started = deferred<RpcResult>();
    let running = false;
    const progress = {
      ...snapshot(null, 1),
      status: "proposing",
      progress: {
        stage: "classifying",
        completed: 4,
        total: 12,
        cached: 3,
        unresolved: 1,
      },
    };
    const slot = await mount(async (input) => {
      const action = (input as { action: string }).action;
      if (action === "start") {
        running = true;
        return started.promise;
      }
      if (action === "cancel") {
        running = false;
        return { state: null };
      }
      return { state: running ? progress : null };
    });
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Organize…" })).toBeTruthy(),
    );
    fireEvent.click(slot.getByRole("button", { name: "Organize…" }));
    await slot.behavior.emitRealtime("changed", {});
    const bar = await slot.findByRole("progressbar", {
      name: "Classifying tasks 4 of 12",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("33");
    expect(slot.getByText("3 already classified · 1 unresolved")).toBeTruthy();
    const cancel = slot.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    started.resolve({ state: progress });
  });
  it("publishes the newer read when an older read resolves later", async () => {
    const first = deferred<RpcResult>();
    const second = deferred<RpcResult>();
    let reads = 0;
    const slot = await mount(async (input) =>
      (input as { action: string }).action === "get"
        ? ++reads === 1
          ? first.promise
          : second.promise
        : { state: null },
    );
    await waitFor(() => expect(reads).toBe(1));
    await slot.behavior.emitRealtime("changed", {});
    second.resolve({ state: snapshot("newer", 2) });
    await waitFor(() => expect(slot.getByText("newer")).toBeTruthy());
    first.resolve({ state: snapshot("older", 1) });
    await Promise.resolve();
    expect(slot.queryByText("older")).toBeNull();
  });

  it("invalidates a pre-command read before its response arrives", async () => {
    const initial = deferred<RpcResult>();
    const command = deferred<RpcResult>();
    let gets = 0;
    const slot = await mount(async (input) =>
      (input as { action: string }).action === "get"
        ? ++gets === 1
          ? Promise.resolve({ state: null })
          : initial.promise
        : command.promise,
    );
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Organize…" })).toBeTruthy(),
    );
    await slot.behavior.emitRealtime("changed", {});
    await waitFor(() => expect(gets).toBe(2));
    fireEvent.click(slot.getByRole("button", { name: "Organize…" }));
    await act(async () => {
      initial.resolve({ state: snapshot("old read", 1) });
      await Promise.resolve();
    });
    expect(slot.queryByText("old read")).toBeNull();
    expect(
      slot.inspection.rpcCalls.some(
        (call) =>
          call.method === "bootstrap" &&
          (call.input as { action?: string }).action === "start",
      ),
    ).toBe(true);
    command.resolve({ state: snapshot("command", 2) });
  });

  it("does not let a newer read get replaced by an older command response", async () => {
    const command = deferred<RpcResult>();
    const read = deferred<RpcResult>();
    let gets = 0;
    const slot = await mount(async (input) =>
      (input as { action: string }).action === "get"
        ? ++gets === 1
          ? Promise.resolve({ state: null })
          : read.promise
        : command.promise,
    );
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Organize…" })).toBeTruthy(),
    );
    fireEvent.click(slot.getByRole("button", { name: "Organize…" }));
    await slot.behavior.emitRealtime("changed", {});
    read.resolve({ state: snapshot("new read", 3) });
    await waitFor(() => expect(slot.getByText("new read")).toBeTruthy());
    await act(async () => {
      command.resolve({ state: snapshot("old command", 2) });
      await Promise.resolve();
    });
    expect(slot.queryByText("old command")).toBeNull();
  });

  it("keeps a command failure visible across an intervening read", async () => {
    const command = deferred<RpcResult>();
    const read = deferred<RpcResult>();
    let gets = 0;
    const slot = await mount(async (input) =>
      (input as { action: string }).action === "get"
        ? ++gets === 1
          ? Promise.resolve({ state: null })
          : read.promise
        : command.promise,
    );
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Organize…" })).toBeTruthy(),
    );
    fireEvent.click(slot.getByRole("button", { name: "Organize…" }));
    command.reject(new Error("command refused"));
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toContain("command refused"),
    );
    await slot.behavior.emitRealtime("changed", {});
    read.resolve({ state: snapshot(null, 3) });
    await Promise.resolve();
    expect(slot.getByRole("alert").textContent).toContain("command refused");
  });

  it("keeps a newer read error over an older successful read", async () => {
    const older = deferred<RpcResult>();
    const newer = deferred<RpcResult>();
    let gets = 0;
    const slot = await mount(async (input) =>
      (input as { action: string }).action === "get"
        ? ++gets === 1
          ? older.promise
          : newer.promise
        : { state: null },
    );
    await waitFor(() => expect(gets).toBe(1));
    await slot.behavior.emitRealtime("changed", {});
    newer.reject(new Error("new read failed"));
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toContain("new read failed"),
    );
    await act(async () => {
      older.resolve({ state: snapshot("old success", 1) });
      await Promise.resolve();
    });
    expect(slot.getByRole("alert").textContent).toContain("new read failed");
  });

  it("keeps the newest read error over an older read failure", async () => {
    const older = deferred<RpcResult>();
    const newer = deferred<RpcResult>();
    let gets = 0;
    const slot = await mount(async (input) =>
      (input as { action: string }).action === "get"
        ? ++gets === 1
          ? older.promise
          : newer.promise
        : { state: null },
    );
    await waitFor(() => expect(gets).toBe(1));
    await slot.behavior.emitRealtime("changed", {});
    newer.reject(new Error("newest read failed"));
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toContain(
        "newest read failed",
      ),
    );
    await act(async () => {
      older.reject(new Error("old read failed"));
      await Promise.resolve();
    });
    expect(slot.getByRole("alert").textContent).toContain("newest read failed");
  });

  it("shows read failures after a successful command releases error ownership", async () => {
    const command = deferred<RpcResult>();
    const recovery = deferred<RpcResult>();
    let gets = 0;
    const slot = await mount(async (input) =>
      (input as { action: string }).action === "get"
        ? ++gets === 1
          ? Promise.resolve({ state: null })
          : recovery.promise
        : command.promise,
    );
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Organize…" })).toBeTruthy(),
    );
    fireEvent.click(slot.getByRole("button", { name: "Organize…" }));
    await act(async () => command.resolve({ state: snapshot(null, 2) }));
    await waitFor(() => expect(gets).toBe(2));
    await act(async () =>
      recovery.reject(new Error("connection lost after command")),
    );
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toContain(
        "connection lost after command",
      ),
    );
  });

  it("handles a read rejection and clears its error after retry succeeds", async () => {
    const retry = deferred<RpcResult>();
    let gets = 0;
    const slot = await mount(async (input) =>
      (input as { action: string }).action === "get"
        ? ++gets === 1
          ? Promise.reject(new Error("read offline"))
          : retry.promise
        : { state: null },
    );
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toContain("read offline"),
    );
    await slot.behavior.emitRealtime("changed", {});
    retry.resolve({ state: null });
    await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
  });

  it("disables Apply and displays stale warning when catalog was modified since preview", async () => {
    const staleState = {
      status: "preview" as const,
      startedAt: 100,
      updatedAt: 100,
      error: null,
      roots: [{ id: "t1", title: "Task 1", sectionId: "sec_a" }],
      mapSnapshot: [
        {
          sectionId: "sec_a",
          name: "Alpha",
          description: "Alpha work",
          aliases: [],
          descriptionSource: "user" as const,
        },
      ],
      preview: {
        catalogRevision: 1,
        isStale: true,
        workstreams: [
          {
            key: "sec_a",
            sectionId: "sec_a",
            name: "Alpha",
            description: "Alpha work",
            aliases: [],
          },
        ],
        creates: [],
        renames: [],
        moves: [],
        assignments: [
          {
            threadId: "t1",
            workstream: "sec_a",
            reason: "Classified as Alpha.",
          },
        ],
        removals: [],
      },
      entryId: null,
      traceIds: [],
    };
    const slot = await mount(async () => ({ state: staleState }));
    await waitFor(() =>
      expect(slot.getByText("Stale proposal")).toBeTruthy(),
    );
    expect(slot.getByRole("alert").textContent).toContain(
      "The catalog or task classifications changed since this proposal was generated",
    );
    const applyButton = slot.getByRole("button", {
      name: "Apply organization",
    }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
    const regenerateButtons = slot.getAllByRole("button", {
      name: "Regenerate",
    });
    expect(regenerateButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("displays specific feature identity on task line and meaningful no-change review", async () => {
    const semanticState = {
      status: "preview" as const,
      startedAt: 100,
      updatedAt: 100,
      error: null,
      roots: [{ id: "t1", title: "Task 1", sectionId: "sec_a" }],
      mapSnapshot: [
        {
          sectionId: "sec_a",
          name: "Alpha",
          description: "Alpha work",
          aliases: [],
          descriptionSource: "user" as const,
        },
      ],
      preview: {
        catalogRevision: 2,
        isStale: false,
        workstreams: [
          {
            key: "sec_a",
            sectionId: "sec_a",
            name: "Alpha",
            description: "Alpha work",
            aliases: [],
          },
        ],
        creates: [],
        renames: [],
        moves: [],
        assignments: [
          {
            threadId: "t1",
            workstream: "sec_a",
            reason: "Classified as Platform · Alpha · SubFeature; grouped under Alpha.",
          },
        ],
        removals: [],
        identities: {
          t1: {
            threadId: "t1",
            entityId: "ent_sub",
            status: "assigned" as const,
            provenance: "automatic" as const,
            label: "Platform · Alpha · SubFeature",
            ancestorIds: ["ent_platform", "ent_alpha"],
            evidence: "evidence-hash",
            inheritedFrom: null,
          },
        },
      },
      entryId: null,
      traceIds: [],
    };
    const slot = await mount(async () => ({ state: semanticState }));
    await waitFor(() =>
      expect(
        slot.getByText(
          "All tasks are already in their recommended workstreams. Nothing changes until you apply.",
        ),
      ).toBeTruthy(),
    );
    // Expand Alpha group details
    fireEvent.click(slot.getByRole("button", { name: /^Alpha/ }));
    expect(
      await slot.findByText("Platform · Alpha · SubFeature"),
    ).toBeTruthy();
  });
});
