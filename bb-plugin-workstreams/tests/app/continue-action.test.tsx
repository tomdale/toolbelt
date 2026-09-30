// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ContinueAction } from "../../src/app/composer/ContinueAction.tsx";
import { Intake, IntakeContext } from "../../src/app/composer/intake.ts";
import type {
  NewThreadDecision,
  RouteDecision,
} from "../../src/server/router.ts";
afterEach(cleanup);
const base = {
  confidence: "high" as const,
  reason: "",
  subject: null,
  traceId: null,
};
const newThread: NewThreadDecision = {
  ...base,
  id: "d_new",
  outcome: "new-thread",
  sectionId: "sec_a",
  workstream: "Alpha",
  title: "",
  placement: {
    projectId: "proj_a",
    environment: { type: "project-default" },
    label: "checkout",
  },
};
const continuation: RouteDecision = {
  ...base,
  id: "d_continue",
  outcome: "continue",
  threadId: "thr_a",
  threadTitle: "Parser tabs",
  sectionId: "sec_a",
  workstream: "Alpha",
  alternative: newThread,
};
const PROMPT = "Keep going on the parser tabs";

async function mount(first: RouteDecision = continuation) {
  const route = vi.fn().mockResolvedValue(first);
  const intake = new Intake(route, null, null);
  intake.observe(PROMPT);
  await intake.resolve();
  const slot = renderSlot(
    {
      component: function Dialog() {
        return (
          <IntakeContext.Provider value={intake}>
            <div role="dialog">
              <textarea aria-label="Prompt" />
              <ContinueAction />
            </div>
          </IntakeContext.Provider>
        );
      },
    },
    {},
    {
      composer: {
        text: PROMPT,
        scope: { kind: "new-thread", projectId: null },
      },
    },
  );
  return { slot, intake, route };
}
const commandEnter = { key: "Enter", metaKey: true, ctrlKey: true };

it("renders nothing outside New work or without a suggestion", async () => {
  const outside = renderSlot({ component: ContinueAction }, {}, {});
  expect(outside.container.querySelector("button")).toBeNull();
  outside.lifecycle.unmount();
  const { slot, intake } = await mount(newThread);
  expect(slot.container.querySelector("button")).toBeNull();
  intake.dispose();
});

it("sends the draft to the suggested thread through the composer's own submit", async () => {
  const { slot, intake } = await mount();
  const button = slot.getByRole("button", {
    name: "Continue Parser tabs instead",
  });
  expect(button.getAttribute("aria-keyshortcuts")).toMatch(
    /^(Meta|Control)\+Enter$/,
  );
  expect(button.textContent).toContain("Parser tabs");
  fireEvent.click(button);
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  // The composer's guard and submit read this target.
  expect(intake.snapshot().submitTarget).toBe("suggestion");
  expect((await intake.forSubmit(PROMPT)).decision.id).toBe("d_continue");
  intake.dispose();
});

it("⌘⏎ inside the dialog continues the thread before the editor can create one", async () => {
  const { slot, intake } = await mount();
  const prompt = slot.getByRole("textbox", { name: "Prompt" });
  const editorKeyDown = vi.fn();
  prompt.addEventListener("keydown", editorKeyDown);
  fireEvent.keyDown(prompt, { key: "Enter" });
  expect(editorKeyDown).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(prompt, commandEnter);
  expect(editorKeyDown).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(slot.inspection.composer.submits).toHaveLength(1));
  // Keys outside the dialog are left alone.
  const outside = document.createElement("textarea");
  document.body.append(outside);
  expect(fireEvent.keyDown(outside, commandEnter)).toBe(true);
  outside.remove();
  expect(slot.inspection.composer.submits).toHaveLength(1);
  intake.dispose();
});

it("without a suggestion ⌘⏎ keeps its native meaning", async () => {
  const { slot, intake } = await mount(newThread);
  const prompt = slot.getByRole("textbox", { name: "Prompt" });
  expect(fireEvent.keyDown(prompt, commandEnter)).toBe(true);
  expect(slot.inspection.composer.submits).toHaveLength(0);
  intake.dispose();
});

it("a failed continuation leaves the new-thread default and says why", async () => {
  const { slot, intake, route } = await mount();
  act(() => intake.observe(`${PROMPT} and spaces`));
  route.mockRejectedValueOnce(new Error("That thread is archived."));
  fireEvent.click(
    slot.getByRole("button", { name: "Continue Parser tabs instead" }),
  );
  await waitFor(() =>
    expect(intake.snapshot().submitError).toBe("That thread is archived."),
  );
  expect(intake.snapshot().submitTarget).toBe("new-thread");
  expect(slot.inspection.composer.submits).toHaveLength(0);
  intake.dispose();
});
