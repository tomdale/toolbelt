import { expect, it } from "vitest";
import { classificationPrompt } from "../model";

it("includes project fallback evidence in classification prompts", () => {
  const prompt = classificationPrompt([
    {
      id: "1",
      title: "Continue work",
      project: "Agent Toolkit",
      repository: null,
      path: null,
      excerpts: "User: Continue. Assistant: What next?",
      timeline: "",
      status: "idle",
      updatedAt: 1,
      sectionId: null,
    },
  ]);
  expect(prompt).toContain('"project":"Agent Toolkit"');
  expect(prompt).toContain("then BB project name");
});
