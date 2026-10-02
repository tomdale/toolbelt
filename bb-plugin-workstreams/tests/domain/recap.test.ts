import { expect, it } from "vitest";
import {
  fileTarget,
  plainText,
  recapSegments,
  recapInputSchema,
  recapToolSchema,
  recapMarkdown,
  recapSchema,
  toRecap,
  reportedAnalysis,
} from "../../src/domain/recap.ts";

it("advertises named parameters on a concrete root object", () => {
  const schema = recapToolSchema.toJSONSchema({ io: "input" });
  expect(schema.type).toBe("object");
  expect(schema).not.toHaveProperty("oneOf");
  expect(schema).not.toHaveProperty("anyOf");
  expect(Object.keys(schema.properties!)).toEqual([
    "state",
    "goal",
    "latest",
    "tasks",
    "timeout",
    "review",
    "links",
    "next",
  ]);
  expect(schema.required).toEqual(["state", "goal"]);
  expect(schema.additionalProperties).toBe(false);
});

it("validates state-specific fields at execution", () => {
  const schema = recapInputSchema.toJSONSchema({ io: "input" });
  const variants = schema.oneOf as Array<{
    properties: Record<string, { const?: string; minItems?: number }>;
    required: string[];
    additionalProperties: boolean;
  }>;
  expect(variants).toHaveLength(3);
  const branch = (state: string) =>
    variants.find((variant) => variant.properties.state?.const === state)!;
  for (const state of ["complete", "review"]) {
    expect(branch(state).properties).toHaveProperty("timeout");
    expect(branch(state).properties).toHaveProperty("tasks");
    expect(branch(state).properties.latest?.minItems).toBe(1);
    expect(branch(state).required).toContain("latest");
    expect(branch(state).additionalProperties).toBe(false);
  }
  expect(branch("review").required).toContain("review");
  expect(branch("waiting").required).toContain("tasks");
  expect(branch("waiting").required).toContain("timeout");
  expect(branch("waiting").properties).toHaveProperty("review");
  expect(branch("complete").properties).toHaveProperty("review");
  const review = {
    state: "review",
    goal: "Finished work",
    latest: ["Tests passed"],
    review: "Check navigation",
  };
  expect(recapInputSchema.safeParse(review).success).toBe(true);
});

it.each([undefined, null, []])("accepts empty unused arrays: %j", (empty) => {
  for (const state of ["complete", "review", "waiting"] as const) {
    const input = {
      state,
      goal: "Fixed recap validation",
      latest: state === "waiting" ? [] : ["Tests passed"],
      tasks: state === "waiting" ? ["Running checks"] : empty,
      timeout: state === "waiting" ? 60 : undefined,
      review: state === "review" ? ["Inspect the fix"] : empty,
    };
    expect(recapToolSchema.safeParse(input).success).toBe(true);
    const recap = toRecap(recapInputSchema.parse(input), {
      id: "r",
      turnId: "t",
      at: 1,
    });
    if (state !== "waiting") expect(recap.tasks).toEqual([]);
    if (state !== "review") expect(recap.review).toEqual([]);
  }
});

it("accepts empty review strings only when review is not required", () => {
  for (const state of ["complete", "waiting"] as const) {
    expect(
      recapInputSchema.safeParse({
        state,
        goal: "Fixed validation",
        latest: state === "waiting" ? [] : ["Tests passed"],
        ...(state === "waiting"
          ? { tasks: ["Running checks"], timeout: 60 }
          : {}),
        review: "",
      }).success,
    ).toBe(true);
  }
  for (const review of [undefined, null, [], "", "   "]) {
    expect(
      recapInputSchema.safeParse({
        state: "review",
        goal: "Fixed validation",
        latest: ["Tests passed"],
        review,
      }).success,
    ).toBe(false);
  }
});

it("rejects substantive unused fields and unknown keys", () => {
  const complete = {
    state: "complete",
    goal: "Fixed validation",
    latest: ["Tests passed"],
  };
  for (const patch of [
    { active: ["Running checks"] },
    { review: ["Inspect the fix"] },
    { review: "Inspect the fix" },
    { extra: [] },
  ])
    expect(recapInputSchema.safeParse({ ...complete, ...patch }).success).toBe(
      false,
    );
});

it("requires active work for a working recap and maps it to in progress", () => {
  const input = {
    state: "waiting",
    goal: "Updating settings",
    tasks: ["Workers are building the toggle."],
    timeout: 60,
    links: [],
  };
  const recap = toRecap(recapInputSchema.parse(input), {
    id: "r",
    turnId: "t",
    at: 1,
  });
  expect(recap).toMatchObject({
    tasks: ["Workers are building the toggle"],
    timeout: 60,
    latest: [],
    review: [],
  });
  const markdown = recapMarkdown(recap);
  expect(markdown).toContain("**Waiting**");
  expect(markdown).toContain("- Workers are building the toggle");
  expect(markdown).toContain("Check status in 60s");
  expect(markdown).not.toContain("**Next:");
  expect(markdown).not.toContain("Nothing needed");
  const analysis = reportedAnalysis(recap, { latestAttentionAt: 1 });
  expect(analysis.state).toBe("in_progress");
  expect(analysis.recap).toBe("Workers are building the toggle");

  const rejects = (patch: Record<string, unknown>) =>
    expect(recapInputSchema.safeParse({ ...input, ...patch }).success).toBe(
      false,
    );
  rejects({ tasks: undefined });
  rejects({ tasks: [] });
  rejects({ tasks: null });
  rejects({ latest: ["Done"] });
  rejects({ next: ["Inspect results"] });
  for (const timeout of [undefined, null, 0, -1, 1.5, 86401])
    rejects({ timeout });
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
    label: "Waiting",
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
  const recap = toRecap(
    { ...input, next: [] },
    { id: "r", turnId: "t", at: 1 },
  );
  expect(recap.links).toEqual([]);
  expect(recapMarkdown({ ...recap, links: input.links })).not.toContain(
    "/work/report.md",
  );
});

it("accepts strings or short titles with messages and descriptions", () => {
  const parsed = recapInputSchema.parse({
    state: "complete",
    goal: "Added dark mode",
    latest: ["Theme toggle works"],
    next: [
      "Run the full test suite",
      {
        title: "Run Tests",
        message: "Run the full test suite and show me the result",
        description: "Check for regressions",
      },
    ],
  });
  expect(parsed.next).toHaveLength(2);
  expect(
    recapInputSchema.safeParse({
      state: "complete",
      goal: "Added dark mode",
      latest: ["Theme toggle works"],
      next: [
        {
          title: "Run The Complete Regression Test Suite",
          message: "Run tests",
        },
      ],
    }).success,
  ).toBe(false);
  const recap = toRecap(parsed, { id: "r", turnId: "t", at: 1 });
  expect(recap.next[1]).toEqual({
    title: "Run Tests",
    message: "Run the full test suite and show me the result",
    description: "Check for regressions",
  });
  expect(recapMarkdown(recap)).toContain(
    "- Run Tests: Run the full test suite and show me the result (Check for regressions)",
  );
});

it("accepts next actions for complete and review, never for waiting", () => {
  const next = ["Run the full test suite", "Open a pull request"];
  for (const state of ["complete", "review"] as const) {
    const parsed = recapInputSchema.parse({
      state,
      goal: "Added dark mode",
      latest: ["Theme toggle works"],
      ...(state === "review" ? { review: ["Try the theme toggle"] } : {}),
      next,
    });
    expect(parsed.next).toEqual(next);
  }
  expect(
    recapInputSchema.safeParse({
      state: "waiting",
      goal: "Waiting for tests",
      tasks: ["Running the suite"],
      timeout: 120,
      next: ["Check back later"],
    }).success,
  ).toBe(false);
  expect(
    recapInputSchema.parse({
      state: "waiting",
      goal: "Waiting for tests",
      tasks: ["Running the suite"],
      timeout: 120,
    }).next,
  ).toEqual([]);
});

it("tidies next actions and reports them in the recap Markdown", () => {
  const input = recapInputSchema.parse({
    state: "complete",
    goal: "Added dark mode.",
    latest: ["Theme toggle works"],
    next: ["Run the full test suite.", "  Open a   pull request  "],
  });
  const recap = toRecap(input, { id: "r", turnId: "t", at: 1 });
  expect(recap.next).toEqual([
    "Run the full test suite",
    "Open a pull request",
  ]);
  expect(recapMarkdown(recap)).toContain(
    "**Next:**\n- Run the full test suite\n- Open a pull request",
  );
});

it("reads stored recaps without next actions as offering none", () => {
  const stored = {
    id: "r",
    turnId: "t",
    at: 1,
    state: "complete",
    goal: "Goal",
    latest: ["Done"],
    review: [],
    links: [],
  };
  expect(recapSchema.parse(stored).next).toEqual([]);
});

it("keeps legacy string lists and reads structured review JSON", () => {
  const stored = {
    id: "r",
    turnId: "t",
    at: 1,
    state: "review",
    goal: "Goal",
    latest: ["Legacy result"],
    review: JSON.stringify([
      { step: "Open Settings", expect: "The panel appears" },
    ]),
    links: [],
  };
  const recap = recapSchema.parse(stored);
  expect(recap).toMatchObject({
    latest: ["Legacy result"],
    review: [{ text: "Open Settings", detail: "The panel appears" }],
  });
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
      { text: "Open Appearance.", detail: "Dark should be available." },
      "Reload Settings",
    ],
  });
  const recap = toRecap(input, { id: "r", turnId: "t", at: 1 });
  expect(recap.review).toEqual([
    { text: "Open Appearance", detail: "Dark should be available" },
    "Reload Settings",
  ]);
  expect(recapMarkdown(recap)).toContain(
    "- Open Appearance\n  - Dark should be available",
  );
});

it("accepts structured and string async task items", () => {
  const parsed = recapInputSchema.parse({
    state: "waiting",
    goal: "Waiting for UI and tests",
    tasks: [
      { text: "Building UI", detail: "The card renders subrows" },
      "Running tests",
    ],
    timeout: 120,
  });
  const recap = toRecap(parsed, { id: "r", turnId: "t", at: 1 });
  expect(recap.tasks).toEqual([
    { text: "Building UI", detail: "The card renders subrows" },
    "Running tests",
  ]);
  expect(recapMarkdown(recap)).toContain(
    "- Building UI\n  - The card renders subrows",
  );
  expect(recapMarkdown(recap)).toContain("- Running tests");
});

it("normalizes legacy step/expect items to generic text/detail", () => {
  const parsed = recapInputSchema.parse({
    state: "review",
    goal: "Compatibility check",
    latest: [
      {
        step: "Implemented generic items",
        expect: "step and expect still work",
      },
    ],
    review: [{ step: "Run tests", expect: "All tests pass" }],
  });
  const recap = toRecap(parsed, { id: "r", turnId: "t", at: 1 });
  expect(recap.latest).toEqual([
    {
      text: "Implemented generic items",
      detail: "step and expect still work",
    },
  ]);
  expect(recap.review).toEqual([
    { text: "Run tests", detail: "All tests pass" },
  ]);
  expect(recapMarkdown(recap)).toContain(
    "- Implemented generic items\n  - step and expect still work",
  );
  expect(recapMarkdown(recap)).toContain(
    "**Review:** Run tests\n  - All tests pass",
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
