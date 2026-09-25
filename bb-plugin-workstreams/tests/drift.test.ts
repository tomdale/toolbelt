import { expect, it } from "vitest";
import { agree, detectDrift, parseDrift } from "../drift";
import { requestTimeline } from "../context";
import type { Context } from "../model";

const drift = (splitSeq: number, confidence: "high" | "medium" | "low") => ({
  from: "Lumen",
  to: "Markdown viewer",
  mainlineTitle: "Lumen build caching",
  splitSeq,
  confidence,
});
const thread = (id: string, timeline: string): Context => ({
  id,
  title: id,
  project: "p",
  repository: null,
  status: "idle",
  updatedAt: 1,
  path: null,
  excerpts: "",
  timeline,
});

it("builds a seq-numbered request timeline without BB notices", () => {
  const ev = (seq: number, text: string) => ({
    type: "client/turn/requested",
    seq,
    data: { input: [{ type: "text", text }] },
  });
  expect(
    requestTimeline([
      ev(1, "Explain caching"),
      ev(9, "[bb system]\n\nchild added"),
      ev(30, "unrelated: build a viewer"),
    ]),
  ).toBe("#1: Explain caching\n#30: unrelated: build a viewer");
  expect(requestTimeline([ev(1, "only one")])).toBe("");
});
it("requires two agreeing checks for a high-confidence split", () => {
  const one = new Map([["a", drift(30, "high")]]);
  expect(
    agree(one, new Map([["a", drift(30, "high")]])).get("a")?.confidence,
  ).toBe("high");
  expect(
    agree(one, new Map([["a", drift(52, "high")]])).get("a")?.confidence,
  ).toBe("medium");
  expect(agree(one, new Map()).get("a")?.confidence).toBe("low");
});
it("skips single-request threads, rejects sub-product and first-request splits", async () => {
  const calls: string[] = [];
  const result = await detectDrift(
    [
      thread("single", ""),
      thread("ok", "#1: Explain caching\n#30: build a viewer"),
      thread("first", "#5: a\n#9: b"),
      thread("sub", "#1: BB\n#8: BB Pi provider"),
    ],
    async (prompt) => {
      calls.push(prompt);
      const [record] = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      const d =
        record.title === "ok"
          ? drift(30, "high")
          : record.title === "first"
            ? drift(5, "high")
            : { ...drift(8, "high"), from: "BB", to: "BB Pi provider" };
      return JSON.stringify({ items: [{ id: record.id, drift: d }] });
    },
  );
  expect(calls).toHaveLength(6);
  expect([...result.keys()]).toEqual(["ok"]);
  expect(result.get("ok")?.confidence).toBe("high");
});
it("treats malformed drift records as no drift but requires coverage", () => {
  expect(
    parseDrift('{"items":[{"id":"1","drift":{"from":1}}]}', ["1"]),
  ).toEqual([null]);
  expect(() => parseDrift('{"items":[]}', ["1"])).toThrow();
});
