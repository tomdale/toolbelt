import { expect, it } from "vitest";
import { contextExcerpt, initialRequest } from "../context";
const input = (text: string) => [{ type: "text", text }];
it("recovers the initial request independently of empty prompt history", () => {
  const initial = initialRequest([
    {
      type: "client/turn/requested",
      data: { input: input("Build the standalone loader") },
    },
  ]);
  const text = contextExcerpt(initial, [], "Ready for next turn");
  expect(text).toContain("Build the standalone loader");
  expect(text).toContain("Initial user request");
});
it("orders recent requests chronologically and deduplicates initial content", () => {
  const text = contextExcerpt(
    "Build BB",
    [
      { createdAt: 3, input: input("Now change Workstreams instead") },
      { createdAt: 1, input: input("Build BB") },
      { createdAt: 2, input: input("Question about the setup") },
    ],
    "Done",
  );
  expect(text.match(/Build BB/g)).toHaveLength(1);
  expect(text.indexOf("Question about")).toBeLessThan(
    text.indexOf("Now change"),
  );
  expect(text).toContain("historical intent");
  expect(text).toContain("unverified");
});
it("bounds and redacts source text without including tool payloads", () => {
  const text = contextExcerpt(
    "api_key=secret " + "x".repeat(8000),
    [
      {
        createdAt: 1,
        input: [{ type: "tool_result", text: "private tool dump" }],
      },
    ],
    "y".repeat(8000),
  );
  expect(text).not.toContain("api_key=secret");
  expect(text).not.toContain("private tool dump");
  expect(text.length).toBeLessThan(5400);
});
it("skips missing text and unrelated events", () => {
  expect(
    initialRequest([
      { type: "item/completed", data: { input: input("tool") } },
      { type: "client/turn/requested", data: { input: [{ type: "image" }] } },
      { type: "client/turn/requested", data: { input: input("Real request") } },
    ]),
  ).toBe("Real request");
});
