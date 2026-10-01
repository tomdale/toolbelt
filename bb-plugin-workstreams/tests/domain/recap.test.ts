import { expect, it } from "vitest";
import {
  fileTarget,
  recapInputSchema,
  recapMarkdown,
  recapSchema,
  toRecap,
} from "../../src/domain/recap.ts";

const files = { environmentId: "env_1", root: "/work/", hostId: "host_1" };

it("opens paths inside the workspace there, and others through the host", () => {
  expect(fileTarget("/work/src/a.ts", files)).toEqual({
    kind: "workspace",
    environmentId: "env_1",
    path: "/work/src/a.ts",
  });
  expect(fileTarget("/workspace/a.ts", files)).toEqual({
    kind: "host",
    hostId: "host_1",
    path: "/workspace/a.ts",
  });
  expect(fileTarget("/tmp/a.md", { ...files, hostId: null })).toBeNull();
  expect(fileTarget("/tmp/a.md", null)).toBeNull();
});

it("accepts links only for review recaps", () => {
  const input = {
    state: "complete",
    goal: "Writing a report",
    latest: ["Report is ready"],
    links: [{ title: "Report", location: "/work/report.md" }],
  };
  expect(recapInputSchema.safeParse(input).success).toBe(false);
  expect(recapInputSchema.parse({ ...input, links: [] }).links).toEqual([]);
  expect(
    recapInputSchema.parse({
      ...input,
      state: "review",
      review: ["Read the report and check that the findings cover each risk"],
    }).links,
  ).toEqual(input.links);
});

it("omits complete links from normalization and stored recap Markdown", () => {
  const input = {
    state: "complete" as const,
    goal: "Writing a report",
    latest: ["Report is ready"],
    links: [{ title: "Report", location: "/work/report.md" }],
  };
  const recap = toRecap(input, { id: "r", turnId: "t", at: 1 });
  expect(recap.links).toEqual([]);
  expect(recapMarkdown({ ...recap, links: input.links })).not.toContain(
    "/work/report.md",
  );
});

it("reads a stored single review line as one step", () => {
  const stored = {
    id: "r",
    turnId: "t",
    at: 1,
    state: "review",
    goal: "Goal",
    latest: ["Latest"],
    links: [],
  };
  expect(recapSchema.parse({ ...stored, review: "Check it" }).review).toEqual([
    "Check it",
  ]);
  expect(recapSchema.parse({ ...stored, review: null }).review).toEqual([]);
});
