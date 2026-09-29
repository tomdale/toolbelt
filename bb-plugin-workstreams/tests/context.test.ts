import { expect, it } from "vitest";
import {
  contextExcerpt,
  initialRequest,
  manualSectionGroup,
  requestTimeline,
} from "../context";
import { logEntrySchema } from "../organize";
const input = (text: string) => [{ type: "text", text }];
it("distinguishes native section provenance using the last active assignment", () => {
  const names = new Map([
    ["auto", "Renamed group"],
    ["manual", "Renamed group"],
  ]);
  const entry = logEntrySchema.parse({
    id: "1",
    at: 1,
    result: "done",
    action: { kind: "section", threadId: "a", section: "Old group" },
    undo: { workstreamsSectionId: "auto" },
  });
  expect(manualSectionGroup("auto", names, [entry], "a")).toBe("Renamed group");
  expect(manualSectionGroup("manual", names, [entry], "a")).toBe(
    "Renamed group",
  );
  const original = new Map([
    ["auto", "Old group"],
    ["manual", "Old group"],
  ]);
  expect(manualSectionGroup("auto", original, [entry], "a")).toBeUndefined();
  expect(manualSectionGroup("manual", original, [entry], "a")).toBe(
    "Old group",
  );
  expect(manualSectionGroup("auto", names, [], "a")).toBe("Renamed group");
  expect(
    manualSectionGroup("auto", names, [{ ...entry, undone: true }], "a"),
  ).toBe("Renamed group");
  expect(manualSectionGroup(null, names, [entry], "a")).toBeUndefined();
});
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

it("keeps temporal coverage across clustered long thread histories", () => {
  const events = Array.from({ length: 180 }, (_, index) => ({
    type: "client/turn/requested",
    seq: (index + 1) * 100,
    data: {
      input: [
        {
          type: "text",
          text:
            index === 88
              ? "Side quest: audit Agent configuration, not Vercel Agent."
              : `status check ${index}`,
        },
      ],
    },
  }));
  const timeline = requestTimeline(events);
  expect(timeline).toContain("#8900: Side quest: audit Agent configuration");
  expect(timeline).toContain("#100: status check 0");
  expect(timeline).toContain("#18000: status check 179");
  expect(timeline.length).toBeLessThanOrEqual(48_000);
});
