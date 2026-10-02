// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { deliveredCardRecord } from "../../../src/app/question/DeliveredQuestion.tsx";
const app = await loadPluginApp(() => import("../../../src/app/index.tsx"));
afterEach(cleanup);
const result = {
  questions: [
    {
      question: "What should we test?",
      header: "Test",
      options: [
        { label: "Theme", description: "Pick a theme", preview: "Dark\nLight" },
      ],
      multiSelect: false,
    },
  ],
  answers: { "What should we test?": "Theme" },
};
const prefix =
  "Your earlier AskUserQuestion tool call has finished. Its result:";
it("replaces the delivered message's raw JSON with inline Q&A and restores host DOM on unmount", async () => {
  const message = render(
    <div data-timeline-row-id="thread:delivery">
      <div>
        <p>{prefix}</p>
        <p>{JSON.stringify(result)}</p>
      </div>
    </div>,
  );
  const overlay = renderSlot(
    app.appOverlays.find((p) => p.id === "delivered-questions")!,
    {},
  );
  await waitFor(() =>
    expect(
      message.container.querySelector("[data-ws-question-history]"),
    ).toBeTruthy(),
  );
  expect(message.getByText("What should we test?")).toBeTruthy();
  expect(message.getByText("Your answer")).toBeTruthy();
  expect(
    message.container.querySelector(".ws-delivered-question"),
  ).toBeTruthy();
  expect(
    message.container.querySelectorAll("[data-ws-delivered-anchor]"),
  ).toHaveLength(1);
  overlay.lifecycle.unmount();
  expect(
    message.container.querySelector("[data-ws-question-history]"),
  ).toBeNull();
  expect(message.container.querySelector(".ws-delivered-question")).toBeNull();
  expect(message.getByText(JSON.stringify(result))).toBeTruthy();
});
it("replaces BB's clipped generated-message preview with an expansion hint", async () => {
  const message = render(
    <div data-timeline-row-id="thread:delivery">
      <div>
        <div>Delivered AskUserQuestion result</div>
        <div>
          <div>
            <div>
              Your earlier AskUserQuestion tool call has finished. Its
              result:...
            </div>
          </div>
        </div>
      </div>
    </div>,
  );
  const overlay = renderSlot(
    app.appOverlays.find((p) => p.id === "delivered-questions")!,
    {},
  );
  await waitFor(() =>
    expect(
      message.container.querySelector(".ws-delivered-question-preview"),
    ).toBeTruthy(),
  );
  expect(
    message.getByText("Expand to view the question and answer"),
  ).toBeTruthy();
  overlay.lifecycle.unmount();
  expect(
    message.container.querySelector(".ws-delivered-question-preview"),
  ).toBeNull();
});
it("does not convert malformed transport data or unrelated text", () => {
  expect(deliveredCardRecord("ordinary message")).toBeNull();
  expect(deliveredCardRecord(prefix + "\n{invalid")).toBeNull();
  expect(deliveredCardRecord(prefix + "\n{}")).toBeNull();
});
