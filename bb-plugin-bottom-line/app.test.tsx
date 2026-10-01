// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
afterEach(cleanup);
const card = { id: "00000000-0000-4000-8000-000000000000", turnId: "turn", kind: "finished", summary: "Finished the report.", deliverables: [{ title: "Report", location: "/tmp/report.md" }] };
function handoff(kind = "finished", running = false) {
  let current: unknown = { card: { ...card, kind }, capped: false, intercepts: 0, environmentId: "env_test" };
  const archive = vi.fn(async () => ({ ok: true }));
  const dismiss = vi.fn(async () => { current = { card: null, capped: false, intercepts: 0, environmentId: "env_test" }; return { ok: true }; });
  const slot = renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
    composer: { scope: { kind: "thread", threadId: "thr_test" }, isRunning: running },
    rpc: { current: () => current, archive, dismiss },
  });
  return { slot, archive, dismiss };
}

describe("completion and deliverable cards", () => {
  it("shows the summary and artifact with user-controlled Archive and Dismiss", async () => {
    const { slot, archive, dismiss } = handoff();
    await slot.findByText("Finished the report.");
    expect(slot.getByText("Report").closest("a")).toBeTruthy();
    expect(archive).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith({ threadId: "thr_test", cardId: card.id }));
    expect(dismiss).not.toHaveBeenCalled();
  });
  it("dismisses without archiving", async () => {
    const { slot, archive, dismiss } = handoff();
    fireEvent.click(await slot.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(dismiss).toHaveBeenCalled());
    expect(archive).not.toHaveBeenCalled();
    await waitFor(() => expect(slot.queryByLabelText("Bottom Line")).toBeNull());
  });
  it("offers Archive only for a finished task and disables it while running", async () => {
    const first = handoff("deliverables");
    await first.slot.findByText("Requested deliverables");
    expect(first.slot.queryByRole("button", { name: "Archive" })).toBeNull();
    first.slot.lifecycle.unmount();
    const second = handoff("finished", true);
    expect((await second.slot.findByRole("button", { name: "Archive" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("questions", () => {
  function questions() {
    const submit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const slot = renderSlot(app.pendingInteractions[0]!, {
      interaction: { id: "input", threadId: "thr_test", title: "Question", createdAt: 0, expiresAt: null, payload: { questions: [{ question: "Which next step?", options: [{ label: "Deploy", description: "Publish the build." }] }] } }, submit, cancel,
    });
    return { slot, submit, cancel };
  }
  it("submits a suggestion or a freeform answer without a default approval", async () => {
    const { slot, submit } = questions();
    expect((slot.getByRole("button", { name: "Send answers" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(slot.getByRole("radio"));
    fireEvent.click(slot.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ answers: ["Deploy"] }));
  });
  it("dismisses without supplying an answer", async () => {
    const { slot, submit, cancel } = questions();
    fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(cancel).toHaveBeenCalled()); expect(submit).not.toHaveBeenCalled();
  });
});
