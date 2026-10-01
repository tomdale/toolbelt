import { expect, it } from "vitest";
import {
  fileTarget,
  plainText,
  recapSegments,
  recapInputSchema,
  recapMarkdown,
  recapSchema,
  toRecap,
  reportedAnalysis,
} from "../../src/domain/recap.ts";

it("requires active work for a working recap and maps it to in progress", () => {
  const input = {
    state: "continuing",
    goal: "Updating settings",
    active: ["Workers are building the toggle."],
    links: [],
  };
  const recap = toRecap(recapInputSchema.parse(input), {
    id: "r",
    turnId: "t",
    at: 1,
  });
  expect(recap).toMatchObject({
    active: ["Workers are building the toggle"],
    latest: [],
    next: [],
    review: [],
  });
  const markdown = recapMarkdown(recap);
  expect(markdown).toContain("**Working**");
  expect(markdown).toContain("- ○ Workers are building the toggle");
  expect(markdown).not.toContain("**Next:");
  expect(markdown).not.toContain("Nothing needed");
  const analysis = reportedAnalysis(recap, { latestAttentionAt: 1 });
  expect(analysis.state).toBe("in_progress");
  expect(analysis.recap).toBe("Workers are building the toggle");

  const full = recapInputSchema.parse({
    ...input,
    latest: ["Theme agreed"],
    next: ["Inspect results"],
  });
  const fullMarkdown = recapMarkdown(
    toRecap(full, { id: "r", turnId: "t", at: 1 }),
  );
  expect(fullMarkdown).toContain("- ✓ Theme agreed");
  expect(fullMarkdown).toContain("**Next:**\n- Inspect results");

  const rejects = (patch: Record<string, unknown>) =>
    expect(recapInputSchema.safeParse({ ...input, ...patch }).success).toBe(
      false,
    );
  // Every item done: report complete, not working.
  rejects({ active: undefined, latest: ["Done"] });
  rejects({ active: [] });
  rejects({ active: ["a", "b"], latest: ["c", "d", "e"] });
  rejects({ review: "Nothing to review" });
  rejects({ links: [{ title: "File", location: "/work/a" }] });
  expect(
    recapInputSchema.safeParse({ ...input, state: "complete", latest: ["x"] })
      .success,
  ).toBe(false);
  expect(
    recapInputSchema.safeParse({ state: "complete", goal: "Goal", latest: [] })
      .success,
  ).toBe(false);
});

it("marks reported working threads but leaves inferred progress unmarked", async () => {
  const { workStateMark } = await import("../../src/domain/presentation.ts");
  expect(workStateMark("in_progress", true)).toEqual({
    glyph: "↻",
    label: "Working",
  });
  expect(workStateMark("in_progress", false).glyph).toBeNull();
});

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

it("keeps structured review steps and writes their expectations", () => {
  const input = recapInputSchema.parse({
    state: "review",
    goal: "Adding dark mode",
    latest: ["Theme toggle works"],
    review: [
      { step: "Open Appearance.", expect: "Dark should be available." },
      "Reload Settings",
    ],
  });
  const recap = toRecap(input, { id: "r", turnId: "t", at: 1 });
  expect(recap.review).toEqual([
    { step: "Open Appearance", expect: "Dark should be available" },
    "Reload Settings",
  ]);
  expect(recapMarkdown(recap)).toContain(
    "- Open Appearance — Dark should be available",
  );
});

it("measures inline Markdown by its visible text", () => {
  const url = `https://example.com/${"a".repeat(200)}`;
  const latest = `Merged [the fix](${url}) after @thread:thr_abc123def review`;
  expect(
    recapInputSchema.safeParse({
      state: "complete",
      goal: "Fixing",
      latest: [latest],
    }).success,
  ).toBe(true);
  expect(
    recapInputSchema.safeParse({
      state: "complete",
      goal: "Fixing",
      latest: ["x".repeat(121)],
    }).success,
  ).toBe(false);
});

it("strips inline Markdown to plain text", () => {
  expect(
    plainText(
      "Shipped **bold** `code` [link](https://a.b) for @thread:thr_1 _now_",
    ),
  ).toBe("Shipped bold code link for @thread:thr_1 now");
  expect(plainText("keep snake_case_name and 2*3*4")).toBe(
    "keep snake_case_name and 2*3*4",
  );
});

it("splits thread mentions and commit hashes out of a line", () => {
  expect(
    recapSegments(
      "Pushed cef4818 for @thread:thr_ab1, see `deadbee1` and [x](https://a.b/cef4818)",
    ),
  ).toEqual([
    { kind: "markdown", text: "Pushed " },
    { kind: "sha", sha: "cef4818" },
    { kind: "markdown", text: " for " },
    { kind: "thread", threadId: "thr_ab1" },
    { kind: "markdown", text: ", see " },
    { kind: "sha", sha: "deadbee1" },
    { kind: "markdown", text: " and [x](https://a.b/cef4818)" },
  ]);
  expect(recapSegments("1234567 deadbeef facade1x")).toEqual([
    { kind: "markdown", text: "1234567 deadbeef facade1x" },
  ]);
});
