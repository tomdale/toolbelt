// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { Intake, IntakeContext } from "../../src/app/composer/intake.ts";
import { IntakeStatus } from "../../src/app/composer/IntakeBanner.tsx";
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
  traceId: null,
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
  first?: RouteDecision,
) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const banner = app.composerCustomizations.find((c) => c.id === "router")!
    .banners![0]!;
  const Banner = banner.component;
  const route = vi.fn().mockResolvedValue(decision);
  if (first) route.mockResolvedValueOnce(first);
  const intake = new Intake(route, workstreamId, workstreamName);
  // The host keys each banner by composer scope, so a project change remounts it.
  let remount!: () => void;
  const slot = renderSlot(
    {
      ...banner,
      component: function Host() {
        const [scope, setScope] = useState(0);
        remount = () => setScope((n) => n + 1);
        return (
          <IntakeContext.Provider value={intake}>
            <Banner key={scope} />
            {/* NewWork renders the live region beside the composer. */}
            <IntakeStatus intake={intake} />
          </IntakeContext.Provider>
        );
      },
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
  return { slot, intake, route, remount: () => act(() => remount()) };
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

it("keeps Settings in place and honors a project picked after opening it", async () => {
  const { slot, intake, route } = await mount();
  await waitFor(
    () => expect(slot.inspection.composer.selections).toHaveLength(1),
    { timeout: 2000 },
  );
  fireEvent.click(slot.getByRole("button", { name: "Settings" }));
  expect(
    slot
      .getByRole("button", { name: "Settings" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(intake.snapshot().settings).toBe(true);
  await slot.behavior.setComposerScope({
    kind: "new-thread",
    projectId: "proj_mine",
  });
  await waitFor(() =>
    expect(route).toHaveBeenLastCalledWith({
      prompt: PROMPT,
      workstreamId: null,
      pickedProjectId: "proj_mine",
    }),
  );
  fireEvent.click(slot.getByRole("button", { name: "Settings" }));
  expect(
    slot
      .getByRole("button", { name: "Settings" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  slot.lifecycle.unmount();
  intake.dispose();
});

it("leaves an ambiguous destination unchosen until the user picks one", async () => {
  const unsure: RouteDecision = {
    id: "d2",
    outcome: "unsure",
    confidence: "low",
    reason: "",
    subject: null,
    traceId: null,
    candidates: [
      { kind: "thread", threadId: "thr_p", title: "Parser tabs" },
      { kind: "workstream", sectionId: "sec_b", name: "Beta" },
    ],
  };
  const { slot, intake, route } = await mount(null, null, PROMPT, unsure);
  const group = await slot.findByRole(
    "group",
    { name: "Possible destinations" },
    { timeout: 2000 },
  );
  expect(slot.getByRole("status").textContent).toBe("Choose where this goes");
  expect(group.querySelector('[aria-pressed="true"]')).toBeNull();
  await act(() =>
    expect(intake.forSubmit(PROMPT)).rejects.toThrow("Choose where"),
  );

  fireEvent.click(slot.getByRole("button", { name: "Parser tabs" }));
  expect(
    slot
      .getByRole("button", { name: "Parser tabs" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(slot.getByRole("status").textContent).toBe("Continue Parser tabs");
  await act(async () => {
    await expect(intake.forSubmit(PROMPT)).resolves.toEqual({
      decision: unsure,
      choice: { threadId: "thr_p" },
    });
  });

  fireEvent.click(slot.getByRole("button", { name: "Beta" }));
  await waitFor(() =>
    expect(route).toHaveBeenLastCalledWith({
      prompt: PROMPT,
      workstreamId: "sec_b",
      pickedProjectId: null,
      // The unsure decision's routing call keeps explaining the choice.
      fromDecisionId: "d2",
    }),
  );
  expect(slot.getByRole("status").textContent).toBe("New thread in Beta");
  slot.lifecycle.unmount();
  intake.dispose();
});

it("returns focus to Settings when the host remounts the banner", async () => {
  const { slot, intake, remount } = await mount(null, null, "");
  slot.getByRole("button", { name: "Settings" }).focus();
  remount();
  expect(document.activeElement).toBe(
    slot.getByRole("button", { name: "Settings" }),
  );
  // Focus that moved on stays where the user put it.
  const elsewhere = document.body.appendChild(document.createElement("button"));
  elsewhere.focus();
  elsewhere.remove();
  remount();
  expect(document.activeElement).toBe(document.body);
  slot.lifecycle.unmount();
  intake.dispose();
});
