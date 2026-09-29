// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { Intake, IntakeContext } from "../../src/app/composer/intake.ts";
import type { RouteDecision } from "../../src/server/router.ts";
import { emptyState } from "./fixtures.ts";

afterEach(cleanup);
const decision: RouteDecision = {
  id: "d1",
  outcome: "new-thread",
  sectionId: "sec_a",
  workstream: "Alpha",
  title: "Fix parser",
  confidence: "high",
  reason: "Same project",
  subject: null,
  placement: {
    projectId: "proj_a",
    environment: { type: "project-default" },
    label: "checkout",
  },
};
const PROMPT = "Fix the parser so it handles tabs";

async function mount(
  workstreamId: string | null = null,
  workstreamName: string | null = null,
  text = PROMPT,
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const banner = app.composerCustomizations.find((c) => c.id === "router")!
    .banners![0]!;
  const Banner = banner.component;
  const route = vi.fn().mockResolvedValue(decision);
  const intake = new Intake(route, workstreamId, workstreamName);
  const slot = renderSlot(
    {
      ...banner,
      component: () => (
        <IntakeContext.Provider value={intake}>
          <Banner />
        </IntakeContext.Provider>
      ),
    },
    {},
    {
      composer: {
        text,
        scope: { kind: "new-thread", projectId: "proj_unrelated" },
      },
      rpc: {
        state: () => ({
          ...emptyState(),
          workstreams: {
            sec_a: { sectionId: "sec_a", name: "Alpha" },
            sec_b: { sectionId: "sec_b", name: "Beta" },
          },
        }),
      },
    },
  );
  return { slot, intake, route };
}

it("shows the workstream selected with + before typing, without classifying", async () => {
  const { slot, intake, route } = await mount("sec_a", "Alpha", "");
  expect(slot.getByRole("status").textContent).toBe("New thread in Alpha");
  expect(route).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
  intake.dispose();
});

it("previews while editing and keeps a manually selected workstream", async () => {
  const { slot, intake, route } = await mount();
  await waitFor(
    () =>
      expect(slot.getByRole("status").textContent).toBe("New thread in Alpha"),
    { timeout: 2000 },
  );
  expect(slot.container.textContent).not.toContain("checkout");
  expect(slot.container.textContent).not.toContain("Same project");
  fireEvent.change(slot.getByRole("combobox", { name: "Workstream" }), {
    target: { value: "sec_b" },
  });
  await slot.behavior.setComposerText("Actually fix the other parser");
  await waitFor(() =>
    expect(route).toHaveBeenLastCalledWith({
      prompt: "Actually fix the other parser",
      workstreamId: "sec_b",
      pickedProjectId: null,
    }),
  );
  expect(slot.getByRole("status").textContent).toBe("New thread in Beta");
  slot.lifecycle.unmount();
  intake.dispose();
});

it("does not reset environment choices when a banner remounts for its project preset", async () => {
  const { slot, intake } = await mount();
  await waitFor(
    () => expect(slot.inspection.composer.selections).toHaveLength(1),
    { timeout: 2000 },
  );
  await slot.behavior.setComposerScope({
    kind: "new-thread",
    projectId: "proj_a",
  });
  await slot.behavior.setComposerText(`${PROMPT} and spaces`);
  await waitFor(() => expect(intake.snapshot().loading).toBe(false), {
    timeout: 2000,
  });
  expect(slot.inspection.composer.selections).toHaveLength(1);
  slot.lifecycle.unmount();
  intake.dispose();
});

it("keeps an in-flight route when the host clears the editor before submit", async () => {
  const { slot, intake, route } = await mount("sec_a", "Alpha");
  let finish!: (value: RouteDecision) => void;
  route.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let submit!: ReturnType<Intake["forSubmit"]>;
  act(() => {
    intake.retry();
    submit = intake.forSubmit(PROMPT);
  });
  await slot.behavior.setComposerText("");
  await act(async () => {
    finish(decision);
    await expect(submit).resolves.toEqual({ decision, choice: null });
  });
  slot.lifecycle.unmount();
  intake.dispose();
});
