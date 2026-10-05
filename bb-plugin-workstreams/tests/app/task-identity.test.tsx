// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState, section, sidebarThread } from "./fixtures.ts";
import type { TopicState, Topic } from "../../src/domain/topics.ts";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

const entities: Topic[] = [
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

const catalogState: TopicState = {
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
      provenance: "full",
      label: "Platform: Auth",
      ancestorIds: ["feat_auth", "prod_platform"],
      evidence: "recap analysis",
      inheritedFrom: "t-root",
    },
    "t-auto": {
      threadId: "t-auto",
      entityId: "feat_auth",
      status: "assigned",
      provenance: "full",
      label: "Platform: Auth",
      ancestorIds: ["feat_auth", "prod_platform"],
      evidence: "recap analysis",
      inheritedFrom: null,
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
    catalog?: TopicState;
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
    sidebarThread("t-auto", { title: "Automatic task", sectionId: "sec_a" }),
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
              provenance: "full",
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

describe("Topic control", () => {
  it("shows a topic the user chose", async () => {
    const slot = await mountTaskIdentityHeader("t-root");
    const button = await slot.findByRole("button", {
      name: "Topic: Platform › Auth (chosen by you)",
    });
    expect(button.textContent).toBe("Platform › Auth");
    fireEvent.click(button);
    const automatic = await screen.findByRole("button", { name: /^Automatic/ });
    expect(automatic.getAttribute("aria-pressed")).toBe("false");
    expect(automatic.textContent).toContain("Let Workstreams choose");
    const chosen = screen.getByRole("button", { name: /^Platform › Auth/ });
    expect(chosen.getAttribute("aria-pressed")).toBe("true");
    slot.lifecycle.unmount();
  });

  it("defaults to Automatic and shows the classifier result below it", async () => {
    const slot = await mountTaskIdentityHeader("t-auto");
    const button = await slot.findByRole("button", {
      name: "Topic: Platform › Auth (automatic)",
    });
    fireEvent.click(button);
    const automatic = await screen.findByRole("button", { name: /^Automatic/ });
    expect(automatic.getAttribute("aria-pressed")).toBe("true");
    expect(automatic.textContent).toBe("AutomaticPlatform › Auth");
    expect(
      screen
        .getByRole("button", { name: /^Platform › Auth/ })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    slot.lifecycle.unmount();
  });

  it("shows No topic when Workstreams found none", async () => {
    const slot = await mountTaskIdentityHeader("t-unresolved-in-workstream");
    const button = await slot.findByRole("button", {
      name: "Topic: No topic (automatic)",
    });
    expect(button.className).toContain("ws-task-identity-unresolved");
    fireEvent.click(button);
    const automatic = await screen.findByRole("button", { name: /^Automatic/ });
    expect(automatic.textContent).toBe("AutomaticNo topic");
    slot.lifecycle.unmount();
  });

  it("shows a fork's parent topic without letting it change", async () => {
    const slot = await mountTaskIdentityHeader("t-child");
    const button = (await slot.findByRole("button", {
      name: "Topic: Platform › Auth (same as parent thread)",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).not.toContain("inherited");
    slot.lifecycle.unmount();
  });

  it("picking a topic saves it as the user's choice", async () => {
    const rpcCalls: { method: string; args: unknown }[] = [];
    const slot = await mountTaskIdentityHeader("t-auto", { rpcCalls });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Topic: Platform › Auth/ }),
    );
    fireEvent.change(screen.getByLabelText("Search topics"), {
      target: { value: "Payments" },
    });
    fireEvent.click(await screen.findByText("Platform › Billing"));
    await waitFor(() => {
      expect(rpcCalls).toEqual([
        {
          method: "taskAssign",
          args: { threadId: "t-auto", entityId: "feat_billing" },
        },
      ]);
    });
    slot.lifecycle.unmount();
  });

  it("choosing Automatic hands the thread back to the classifier", async () => {
    const rpcCalls: { method: string; args: unknown }[] = [];
    const slot = await mountTaskIdentityHeader("t-root", { rpcCalls });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Topic: Platform › Auth/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Automatic/ }));
    await waitFor(() => {
      expect(rpcCalls).toEqual([
        { method: "taskReclassify", args: { threadId: "t-root" } },
      ]);
    });
    slot.lifecycle.unmount();
  });

  it("Automatic can't be chosen again while it's already on", async () => {
    const slot = await mountTaskIdentityHeader("t-auto");
    fireEvent.click(
      await slot.findByRole("button", { name: /^Topic: Platform › Auth/ }),
    );
    const automatic = (await screen.findByRole("button", {
      name: /^Automatic/,
    })) as HTMLButtonElement;
    expect(automatic.disabled).toBe(true);
    slot.lifecycle.unmount();
  });
});
