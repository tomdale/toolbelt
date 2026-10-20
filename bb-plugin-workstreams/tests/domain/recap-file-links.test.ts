import { expect, it } from "vitest";
import {
  normalizeRecapFileLinks,
  recapHostFileLink,
} from "../../src/domain/recapFileLinks.ts";
import {
  recapMarkdown,
  recapSegments,
  type Recap,
} from "../../src/domain/recap.ts";

it.each([
  ["docs/Project Plan.md", "docs/Project%20Plan.md"],
  ["Project Plan.md", "Project%20Plan.md"],
  ["/work/My Notes/Plan.md:12", "/work/My%20Notes/Plan.md:12"],
  ["../My Notes/Plan.md#next-steps", "../My%20Notes/Plan.md#next-steps"],
  ["docs/My%20Notes/Project Plan.md", "docs/My%20Notes/Project%20Plan.md"],
  ["docs/Plan (draft (2)).md", "docs/Plan%20%28draft%20%282%29%29.md"],
  [String.raw`docs/My Notes/Plan\).md`, "docs/My%20Notes/Plan%29.md"],
])(
  "encodes file destination %s without changing its label",
  (path, encoded) => {
    expect(normalizeRecapFileLinks(`Read [the plan](${path}) now`)).toBe(
      `Read [the plan](${encoded}) now`,
    );
  },
);

it.each([
  '"Project overview"',
  "'Project overview'",
  "(Project overview)",
  '"Overview (draft)"',
  '"Overview ) draft"',
])("preserves the link title %s", (title) => {
  expect(normalizeRecapFileLinks(`[plan](docs/My Plan.md ${title})`)).toBe(
    `[plan](docs/My%20Plan.md ${title})`,
  );
});

it.each([
  "[plan](docs/plan.md)",
  '[plan](docs/plan.md "Project overview")',
  "[plan](docs/My%20Plan.md)",
  "[plan](<docs/My Plan.md>)",
  "[site](https://example.com/My Plan.md)",
  "[site](//example.com/My Plan.md)",
  "[anchor](#My Section)",
  '[plan](docs/My Plan.md "broken title)',
  "[plan](docs/My Plan.md",
  "`[plan](docs/My Plan.md)`",
  "``a ` [plan](docs/My Plan.md)``",
  String.raw`\[plan](docs/My Plan.md)`,
])(
  "preserves valid syntax, non-file destinations, and literal examples: %s",
  (text) => {
    expect(normalizeRecapFileLinks(text)).toBe(text);
  },
);

it("keeps file links whole around recap thread and commit tokens", () => {
  expect(
    recapSegments("[plan](docs/My abc1234 Plan.md) after abc1234"),
  ).toEqual([
    { kind: "markdown", text: "[plan](docs/My%20abc1234%20Plan.md) after " },
    { kind: "sha", sha: "abc1234" },
  ]);
});

it.each([
  [
    "file:///home/test/.bb/backups/recap/README.md",
    "/home/test/.bb/backups/recap/README.md",
  ],
  ["file:///tmp/My%20Notes.md", "/tmp/My Notes.md"],
  ["file://localhost/tmp/notes.md", "/tmp/notes.md"],
  ["file:///work/../notes.md", "/notes.md"],
  ["file:///work/%2e%2e/notes.md", "/notes.md"],
  ["file:///tmp/notes%23draft.md", "/tmp/notes#draft.md"],
])("decodes the host file URL %s", (href, path) => {
  expect(recapHostFileLink(href)).toEqual({ path, location: null });
});

it.each([
  ["file:///tmp/notes.md#L12", 12, 12],
  ["file:///tmp/notes.md#L12-L15", 12, 15],
])("keeps a file location in %s", (href, startLine, endLine) => {
  expect(recapHostFileLink(href)).toEqual({
    path: "/tmp/notes.md",
    location: { kind: "range", startLine, endLine },
  });
});

it.each([
  "docs/notes.md",
  "/work/notes.md",
  "/threads/thread-id",
  "https://example.com/notes.md",
  "//example.com/notes.md",
  "file://remote/tmp/notes.md",
  "#notes",
  "javascript:alert(1)",
  "file:///tmp/notes%00.md",
  "file:///tmp/notes%ZZ.md",
  "file:///tmp/notes.md#L0",
  "file:///tmp/notes.md#L15-L12",
  "file:///tmp/notes.md#L99999999999999999999",
  "file:///tmp/notes.md?query",
  "file:////remote/notes.md",
  "file:///",
  "file:///tmp/",
])("does not claim non-file or invalid URL %s", (href) => {
  expect(recapHostFileLink(href)).toBeNull();
});

it("normalizes links in the recap's timeline Markdown as well as the card", () => {
  const recap: Recap = {
    id: "r1",
    turnId: "turn",
    at: 1,
    state: "review",
    goal: "Wrote [the plan](docs/My Plan.md)",
    latest: [
      {
        text: "Read [the report](docs/My Report.md)",
        detail: "[Notes](docs/My Notes.md)",
      },
    ],
    review: ["Inspect [the draft](docs/My Draft.md)"],
    links: [{ title: "Plan", location: "/work/My Plan.md" }],
    next: [],
  };
  const markdown = recapMarkdown(recap);
  for (const path of [
    "docs/My%20Plan.md",
    "docs/My%20Report.md",
    "docs/My%20Notes.md",
    "docs/My%20Draft.md",
    "/work/My%20Plan.md",
  ])
    expect(markdown).toContain(`](${path})`);
});
