// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("../../../src/app/index.tsx"));
afterEach(cleanup);
it("keeps prompts, suggestions, previews, answers and dismissal readable", async () => {
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
    app.threadPanelActions.find((p) => p.id === "question-history")!,
    { threadId: "thread", params: null },
    {
      rpc: {
        question_history: () => [
          {
            id: "answered",
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
          },
          {
            id: "dismissed",
            at: null,
            status: "dismissed",
            payload,
            result: null,
          },
        ],
      },
    },
  );
  await slot.findByText("SQLite with replicas");
  expect(slot.getAllByText("Which database?")).toHaveLength(2);
  expect(slot.getAllByText("CREATE TABLE test;")).toHaveLength(2);
  expect(
    slot.getByText("Dismissed without an answer or approval"),
  ).toBeTruthy();
});
