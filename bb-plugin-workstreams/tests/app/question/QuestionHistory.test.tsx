// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("../../../src/app/index.tsx"));
afterEach(cleanup);
it("renders the saved Q&A at the form row without a header or panel", async () => {
  expect(app.threadHeaderActions.some((p) => p.id === "question-history")).toBe(
    false,
  );
  expect(app.threadPanelActions.some((p) => p.id === "question-history")).toBe(
    false,
  );
  const payload = {
    questions: [
      {
        id: "q0",
        prompt: "Which database?",
        shortLabel: "Database",
        multiSelect: false,
        allowFreeText: true,
        options: [
          {
            value: "q0o0",
            label: "SQLite",
            description: "Embedded",
            preview: "CREATE TABLE test;",
          },
        ],
      },
    ],
  };
  const slot = renderSlot(
    app.timelineRenderers.find(
      (p) => p.kind === "workstreams/ask-user-question",
    )!,
    {
      row: {
        id: "thread:form:interaction",
        threadId: "thread",
        turnId: null,
        kind: "workstreams/ask-user-question",
        toolName: null,
        status: "completed",
        startedAt: 123,
        completedAt: null,
      },
      payload: null,
      presentation: null,
      thread: { id: "thread", providerId: "pi" },
      Original: () => <p>Original row</p>,
    },
    {
      rpc: {
        question_at: () => ({
          id: "saved",
          at: 123,
          status: "answered",
          payload,
          result: {
            questions: [
              {
                question: "Which database?",
                header: "Database",
                multiSelect: false,
                options: [],
              },
            ],
            answers: { "Which database?": "SQLite with replicas" },
          },
        }),
      },
    },
  );
  await slot.findByText("SQLite with replicas");
  expect(slot.getByText("Which database?")).toBeTruthy();
  expect(slot.getByText("Options offered")).toBeTruthy();
  expect(slot.getByText("CREATE TABLE test;")).toBeTruthy();
  expect(slot.queryByText("Original row")).toBeNull();
});
