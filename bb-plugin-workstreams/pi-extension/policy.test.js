import { expect, it } from "vitest";
import { requestText, parseDecision, decisionPrompt } from "./policy.js";

it("extracts text from user messages but ignores non-text content", () => {
  expect(
    requestText({
      role: "user",
      content: [{ type: "text", text: "Fix caching" }, { type: "image" }],
    }),
  ).toBe("Fix caching");
  expect(
    requestText({ role: "assistant", content: "not a user request" }),
  ).toBe("");
});
it("accepts only valid bounded decisions", () => {
  expect(parseDecision('{"sideQuest":false}')).toEqual({ sideQuest: false });
  expect(
    parseDecision(
      '{"sideQuest":true,"title":" Viewer ","reason":"Different work"}',
    ),
  ).toEqual({ sideQuest: true, title: "Viewer", reason: "Different work" });
  expect(parseDecision('{"sideQuest":true}')).toBeNull();
});
it("labels the old topic and the incoming request", () => {
  expect(
    decisionPrompt("Dockside badge change", "Make a markdown viewer"),
  ).toContain("New request:\\nMake a markdown viewer");
});
