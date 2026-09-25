import { expect, it } from "vitest";
import { decisionPrompt, parseDecision, requestText } from "./policy";

it("extracts text from user messages but ignores non-text content", () => {
  expect(
    requestText({
      role: "user",
      content: [
        { type: "text", text: "Fix caching" },
        { type: "image", data: "ignored" },
      ],
    }),
  ).toBe("Fix caching");
  expect(
    requestText({ role: "assistant", content: "not a user request" }),
  ).toBe("");
});

it("accepts only valid bounded side-quest decisions", () => {
  expect(parseDecision('{"sideQuest":false}')).toEqual({ sideQuest: false });
  expect(
    parseDecision(
      '{"sideQuest":true,"title":"  New project  ","reason":"Different product"}',
    ),
  ).toEqual({
    sideQuest: true,
    title: "New project",
    reason: "Different product",
  });
  expect(parseDecision('{"sideQuest":true}')).toBeNull();
  expect(parseDecision("not json")).toBeNull();
});

it("separates existing topic text from the new request", () => {
  const events = [
    {
      type: "client/turn/requested",
      seq: 2,
      data: { input: [{ type: "text", text: "Original work" }] },
    },
    {
      type: "client/turn/requested",
      seq: 4,
      data: { input: [{ type: "text", text: "[bb system] notice" }] },
    },
    {
      type: "client/turn/requested",
      seq: 6,
      data: { input: [{ type: "text", text: "Separate this" }] },
    },
  ];
  expect(decisionPrompt("Original work", "Separate this")).toContain(
    "Existing thread topic, oldest to newest:\\nOriginal work\\n\\nNew request:\\nSeparate this",
  );
});

it("labels context as existing topic and incoming request", () => {
  expect(decisionPrompt("Existing work", "New request")).toContain(
    "New request:\nNew request",
  );
});
