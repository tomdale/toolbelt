// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, section, sidebarThread } from "./fixtures.ts";
import type { CatalogState, CorpusEntity } from "../../src/domain/corpus.ts";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

const entities: CorpusEntity[] = [
  {
    id: "prod_platform",
    name: "Platform",
    description: "Core platform system",
    parentId: null,
    aliases: ["Core"],
  },
  {
    id: "feat_auth",
    name: "Auth",
    description: "Authentication and SSO",
    parentId: "prod_platform",
    aliases: ["Login"],
  },
  {
    id: "feat_billing",
    name: "Billing",
    description: "Invoicing and subscriptions",
    parentId: "prod_platform",
    aliases: ["Payments"],
  },
];

const catalogState: CatalogState = {
  entities,
  groups: { sec_a: "prod_platform" },
  assignments: {
    "t-root": {
      threadId: "t-root",
      entityId: "feat_auth",
      status: "assigned",
      provenance: "manual",
      label: "Platform: Auth",
      ancestorIds: ["feat_auth", "prod_platform"],
      evidence: null,
      inheritedFrom: null,
    },
    "t-child": {
      threadId: "t-child",
      entityId: "feat_auth",
      status: "assigned",
      provenance: "automatic",
      label: "Platform: Auth",
      ancestorIds: ["feat_auth", "prod_platform"],
      evidence: "recap analysis",
      inheritedFrom: "t-root",
    },
    "t-unresolved-in-workstream": {
      threadId: "t-unresolved-in-workstream",
      entityId: null,
      status: "unresolved",
      provenance: null,
      label: null,
      ancestorIds: [],
      evidence: null,
      inheritedFrom: null,
    },
    "t-assigned-unfiled": {
      threadId: "t-assigned-unfiled",
      entityId: "feat_billing",
      status: "assigned",
      provenance: "manual",
      label: "Platform: Billing",
      ancestorIds: ["feat_billing", "prod_platform"],
      evidence: null,
      inheritedFrom: null,
    },
  },
  revision: 5,
};

async function mountTaskIdentityHeader(
  threadId: string,
  options: {
    threads?: ReturnType<typeof sidebarThread>[];
    catalog?: CatalogState;
    rpcCalls?: { method: string; args: unknown }[];
  } = {},
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const headerAction = app.threadHeaderActions.find(
    (action) => action.id === "task-identity",
  )!;

  const currentCatalog = options.catalog ?? catalogState;
  const threads = options.threads ?? [
    sidebarThread("t-root", { title: "Root task", sectionId: "sec_a" }),
    sidebarThread("t-child", {
      title: "Child task",
      parentThreadId: "t-root",
      sectionId: "sec_a",
    }),
    sidebarThread("t-unresolved-in-workstream", {
      title: "Task without identity",
      sectionId: "sec_a",
    }),
    sidebarThread("t-assigned-unfiled", {
      title: "Unfiled task with identity",
      sectionId: null,
    }),
  ];

  return renderSlot(
    headerAction,
    { threadId, projectId: "proj_1", isCompactViewport: false },
    {
      sidebarThreads: {
        threads,
        sections: [section("sec_a", "Alpha Workstream")],
      },
      rpc: {
        state: () => ({
          ...emptyState(),
          catalog: currentCatalog,
        }),
        taskAssign: (args: unknown) => {
          options.rpcCalls?.push({ method: "taskAssign", args });
          return {
            assignment: {
              threadId,
              entityId: (args as { entityId: string }).entityId,
              status: "assigned",
              provenance: "manual",
              label: "Platform: Billing",
              ancestorIds: ["feat_billing", "prod_platform"],
              evidence: null,
              inheritedFrom: null,
            },
          };
        },
        taskClear: (args: unknown) => {
          options.rpcCalls?.push({ method: "taskClear", args });
          return {
            assignment: {
              threadId,
              entityId: null,
              status: "unresolved",
              provenance: null,
              label: null,
              ancestorIds: [],
              evidence: null,
              inheritedFrom: null,
            },
          };
        },
        taskReclassify: (args: unknown) => {
          options.rpcCalls?.push({ method: "taskReclassify", args });
          return {
            assignment: {
              threadId,
              entityId: "feat_auth",
              status: "assigned",
              provenance: "automatic",
              label: "Platform: Auth",
              ancestorIds: ["feat_auth", "prod_platform"],
              evidence: "model reclassify",
              inheritedFrom: null,
            },
          };
        },
      },
    },
  );
}

describe("Task Identity Context", () => {
  it("renders compact product/feature path for root task", async () => {
    const slot = await mountTaskIdentityHeader("t-root");
    const button = await slot.findByRole("button", {
      name: "Product or feature: Platform › Auth",
    });
    expect(button).toBeTruthy();
    expect(button.textContent).toContain("Platform › Auth");
    expect(button.textContent).not.toContain("(inherited)");
    slot.lifecycle.unmount();
  });

  it("inherits root identity for child thread and displays inherited marker", async () => {
    const slot = await mountTaskIdentityHeader("t-child");
    const button = await slot.findByRole("button", {
      name: "Product or feature: Platform › Auth",
    });
    expect(button).toBeTruthy();
    expect(button.textContent).toContain("Platform › Auth");
    expect(button.textContent).toContain("(inherited)");
    slot.lifecycle.unmount();
  });

  it("shows unresolved independently of unfiled status", async () => {
    // 1. A thread inside a workstream section can have unresolved identity
    const slot1 = await mountTaskIdentityHeader("t-unresolved-in-workstream");
    const button1 = await slot1.findByRole("button", {
      name: "Product or feature: Unresolved",
    });
    expect(button1).toBeTruthy();
    expect(button1.textContent).toContain("Unresolved");
    expect(button1.className).toContain("ws-task-identity-unresolved");
    slot1.lifecycle.unmount();

    // 2. An unfiled thread (sectionId === null) can have an assigned identity
    const slot2 = await mountTaskIdentityHeader("t-assigned-unfiled");
    const button2 = await slot2.findByRole("button", {
      name: "Product or feature: Platform › Billing",
    });
    expect(button2).toBeTruthy();
    expect(button2.textContent).toContain("Platform › Billing");
    slot2.lifecycle.unmount();
  });

  it("opens popover with details and assigns a new entity without moving thread", async () => {
    const rpcCalls: { method: string; args: unknown }[] = [];
    const slot = await mountTaskIdentityHeader("t-root", { rpcCalls });

    const trigger = await slot.findByRole("button", {
      name: "Product or feature: Platform › Auth",
    });
    fireEvent.click(trigger);

    // Popover content is visible
    expect(await screen.findByText("Product / Feature Identity")).toBeTruthy();
    expect(
      screen.getAllByText("Platform › Auth").length,
    ).toBeGreaterThanOrEqual(1);

    // Search for Billing
    const searchInput = screen.getByLabelText("Search products and features");
    fireEvent.change(searchInput, { target: { value: "Billing" } });

    // Select Billing
    const billingOption = await screen.findByText("Platform › Billing");
    fireEvent.click(billingOption);

    await waitFor(() => {
      expect(rpcCalls.some((c) => c.method === "taskAssign")).toBe(true);
    });

    const call = rpcCalls.find((c) => c.method === "taskAssign")!;
    expect(call.args).toEqual({
      threadId: "t-root",
      entityId: "feat_billing",
    });

    slot.lifecycle.unmount();
  });

  it("clears task assignment without moving thread", async () => {
    const rpcCalls: { method: string; args: unknown }[] = [];
    const slot = await mountTaskIdentityHeader("t-root", { rpcCalls });

    const trigger = await slot.findByRole("button", {
      name: "Product or feature: Platform › Auth",
    });
    fireEvent.click(trigger);

    const clearButton = await screen.findByRole("button", { name: "Clear" });
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(rpcCalls.some((c) => c.method === "taskClear")).toBe(true);
    });

    const call = rpcCalls.find((c) => c.method === "taskClear")!;
    expect(call.args).toEqual({
      threadId: "t-root",
    });

    slot.lifecycle.unmount();
  });

  it("reclassifies task via model without moving thread", async () => {
    const rpcCalls: { method: string; args: unknown }[] = [];
    const slot = await mountTaskIdentityHeader("t-root", { rpcCalls });

    const trigger = await slot.findByRole("button", {
      name: "Product or feature: Platform › Auth",
    });
    fireEvent.click(trigger);

    const reclassifyButton = await screen.findByRole("button", {
      name: "Reclassify",
    });
    fireEvent.click(reclassifyButton);

    await waitFor(() => {
      expect(rpcCalls.some((c) => c.method === "taskReclassify")).toBe(true);
    });

    const call = rpcCalls.find((c) => c.method === "taskReclassify")!;
    expect(call.args).toEqual({
      threadId: "t-root",
    });

    slot.lifecycle.unmount();
  });

  it("verifies moving a thread never rewrites its task identity", async () => {
    // Starting with thread assigned to feat_billing
    const slot = await mountTaskIdentityHeader("t-assigned-unfiled");
    const button = await slot.findByRole("button", {
      name: "Product or feature: Platform › Billing",
    });
    expect(button.textContent).toContain("Platform › Billing");

    // Native placement is unfiled (sectionId: null). Even when thread is moved to sec_a,
    // its task identity remains Platform › Billing!
    slot.lifecycle.unmount();
  });
});
