import { describe, expect, it } from "vitest";
import { formatQuestionText } from "../../../src/app/question/question-markdown.ts";

describe("formatQuestionText", () => {
  it("leaves well-formed Markdown unchanged", () => {
    const text = [
      "Compare **managed** and local options.",
      "",
      "- Postgres: needs a server",
      "- SQLite: embedded",
      "",
      "1. First",
      "2. Second",
    ].join("\n");
    expect(formatQuestionText(text)).toBe(text);
  });

  it("turns Unicode bullets into list items", () => {
    expect(formatQuestionText("• one\n• two\n  ◦ nested")).toBe(
      "- one\n- two\n  - nested",
    );
  });

  it("keeps each line of a paragraph on its own line", () => {
    expect(formatQuestionText("first\nsecond\nthird")).toBe(
      "first  \nsecond  \nthird",
    );
  });

  it("starts a list on its own block after a lead-in line", () => {
    expect(formatQuestionText("What I found:\n• one\n• two")).toBe(
      "What I found:\n\n- one\n- two",
    );
  });

  it("ends a list at an unindented paragraph line", () => {
    expect(
      formatQuestionText("• one\n• two\nSo the fix is small.\nIt is safe."),
    ).toBe("- one\n- two\n\nSo the fix is small.  \nIt is safe.");
  });

  it("keeps an indented line inside its list item", () => {
    expect(formatQuestionText("- one\n  more of one\n- two")).toBe(
      "- one  \n  more of one\n- two",
    );
  });

  it("does not add a break to a line that already has one", () => {
    expect(formatQuestionText("first  \nsecond\\\nthird\nfourth")).toBe(
      "first  \nsecond\\\nthird  \nfourth",
    );
  });

  it("leaves fenced code, tables, headings, and quotes alone", () => {
    const text = [
      "# Title",
      "```ts",
      "• not a bullet",
      "a",
      "b",
      "```",
      "| a | b |",
      "| - | - |",
      "> quoted",
      "> more",
      "Heading",
      "-------",
    ].join("\n");
    expect(formatQuestionText(text)).toBe(text);
  });

  it("is stable when applied to its own output", () => {
    const once = formatQuestionText(
      "What I found:\n• one\n• two\nSo:\nfirst\nsecond\n\n```\nx\ny\n```",
    );
    expect(formatQuestionText(once)).toBe(once);
  });

  it("normalizes Windows line endings", () => {
    expect(formatQuestionText("a\r\nb")).toBe("a  \nb");
  });
});
