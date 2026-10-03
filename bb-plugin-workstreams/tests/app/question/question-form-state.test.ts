import { describe, expect, it } from "vitest";
import {
  buildQuestionAnswers,
  createInitialFormState,
  isQuestionAnswered,
  type Question,
} from "../../../src/app/question/question-form-state.ts";

const question: Question = {
  id: "q0",
  prompt: "What should I inspect?",
  shortLabel: "Inspect",
  multiSelect: false,
  allowFreeText: true,
  options: [],
};

describe("question freeform composer answers", () => {
  it("accepts attachment-only answers and includes attachment references", () => {
    const state = createInitialFormState([question]);
    state.q0!.otherAttachments = [
      {
        type: "localImage",
        projectId: "project-a",
        path: "uploads/screenshot.png",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 128,
      },
      {
        type: "localFile",
        projectId: "project-a",
        path: "uploads/trace.log",
        name: "trace.log",
        mimeType: "text/plain",
        sizeBytes: 256,
      },
    ];

    expect(isQuestionAnswered(question, state.q0!)).toBe(true);
    expect(buildQuestionAnswers([question], state)).toEqual({
      q0: {
        selected: [],
        attachments: state.q0!.otherAttachments,
      },
    });
  });
});
