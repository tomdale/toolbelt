import { expect, it } from "vitest";
import { fileTarget, recapSchema } from "../../src/domain/recap.ts";

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
