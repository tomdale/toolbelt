import { describe, expect, it } from "vitest";
import {
  buildSupervisionPrompt,
  parseSupervision,
  type SupervisionInput,
} from "../../src/domain/supervision.ts";

const input: SupervisionInput = {
  sensitivity: "balanced",
  context: "The user returns to release and test automation across repos.",
  workstreams: [
    {
      id: "platform",
      name: "Platform",
      description: "Platform work",
      descriptionSource: "user",
      roots: [
        {
          id: "r1",
          title: "Build reusable releases",
          recap: "Release automation",
          revision: 11,
          notebook: "We keep returning to shared release pipelines.",
          notebookUpdatedAt: 100,
          eligible: true,
        },
        {
          id: "r2",
          title: "Version release artifacts",
          recap: "Artifact signing",
          revision: 12,
          notebook: "Signing is part of our recurring release effort.",
          notebookUpdatedAt: 101,
          eligible: true,
        },
        {
          id: "r3",
          title: "Improve test harness",
          recap: "Test automation",
          revision: 13,
          notebook: "Repeated work on integration test infrastructure.",
          notebookUpdatedAt: 102,
          eligible: true,
        },
        {
          id: "r4",
          title: "Fix one flaky test",
          recap: null,
          revision: 14,
          notebook: null,
          notebookUpdatedAt: null,
          eligible: true,
        },
      ],
    },
    {
      id: "releases",
      name: "Release engineering",
      description: "Recurring build, signing, and release pipelines",
      descriptionSource: "user",
      roots: [
        {
          id: "r5",
          title: "Release service",
          recap: "Release pipeline",
          revision: 21,
          notebook: "Maintains the release pipeline.",
          notebookUpdatedAt: 110,
          eligible: true,
        },
      ],
    },
  ],
};
const group = (overrides: Record<string, unknown> = {}) => ({
  sourceSectionId: "platform",
  destination: { kind: "new", name: "Release automation" },
  threadIds: ["r1", "r2"],
  reason: "Both notebooks describe recurring release pipeline work.",
  confidence: 0.91,
  ...overrides,
});
const existing = (sectionId: string, threadIds: string[]) =>
  group({ destination: { kind: "existing", sectionId }, threadIds });

describe("notebook supervision prompt", () => {
  it("frames within-product recurring efforts and untrusted notebook evidence", () => {
    const prompt = buildSupervisionPrompt(input);
    expect(prompt).toContain(
      "Several distinct recurring efforts may belong to one product",
    );
    expect(prompt).toContain("<data>");
    expect(prompt).toContain("We keep returning to shared release pipelines.");
    expect(prompt).toContain(
      "User-authored descriptions define intended workstream scope",
    );
  });
  it("bounds the snapshot passed to the model", () => {
    const huge: SupervisionInput = {
      ...input,
      context: "brief ".repeat(20_000),
      workstreams: input.workstreams.map((w) => ({
        ...w,
        roots: Array.from({ length: 400 }, (_, i) => ({
          id: `${w.id}-${i}`,
          title: "root ".repeat(500),
          recap: "recap ".repeat(500),
          revision: i,
          notebook: "note ".repeat(2000),
          notebookUpdatedAt: i,
          eligible: true,
        })),
      })),
    };
    const prompt = buildSupervisionPrompt(huge);
    expect(prompt.length).toBeLessThan(100_000);
    expect((prompt.match(/"revision":/g) ?? []).length).toBeLessThanOrEqual(60);
  });
});

describe("closed-set destination validation", () => {
  it("does not rename an entire effort by spinning all roots into a new section", () => {
    expect(
      parseSupervision(
        JSON.stringify({
          groups: [
            group({
              threadIds: ["r1", "r2", "r3", "r4"],
              destination: { kind: "new", name: "Platform engineering" },
            }),
          ],
        }),
        input,
      ),
    ).toEqual([]);
  });
  it("converts a new destination into a spin-out", () => {
    expect(
      parseSupervision(JSON.stringify({ groups: [group()] }), input),
    ).toMatchObject([
      { kind: "spin-out", name: "Release automation", threadIds: ["r1", "r2"] },
    ]);
  });
  it("maps existing destinations to moves or complete merges", () => {
    expect(
      parseSupervision(
        JSON.stringify({ groups: [existing("releases", ["r3"])] }),
        input,
      ),
    ).toMatchObject([{ kind: "move", targetSectionId: "releases" }]);
    expect(
      parseSupervision(
        JSON.stringify({
          groups: [existing("releases", ["r1", "r2", "r3", "r4"])],
        }),
        input,
      ),
    ).toMatchObject([{ kind: "merge", targetSectionId: "releases" }]);
  });
  it("rejects unknown roots/targets, wrong source and duplicate IDs", () => {
    expect(
      parseSupervision(
        JSON.stringify({ groups: [existing("missing", ["r1", "r2"])] }),
        input,
      ),
    ).toEqual([]);
    expect(
      parseSupervision(
        JSON.stringify({ groups: [group({ threadIds: ["foreign", "r1"] })] }),
        input,
      ),
    ).toEqual([]);
    expect(
      parseSupervision(
        JSON.stringify({ groups: [group({ threadIds: ["r1", "r5"] })] }),
        input,
      ),
    ).toEqual([]);
    expect(
      parseSupervision(
        JSON.stringify({ groups: [group({ threadIds: ["r1", "r1"] })] }),
        input,
      ),
    ).toEqual([]);
    expect(
      parseSupervision(
        JSON.stringify({
          groups: [
            group({ destination: { kind: "existing", sectionId: "missing" } }),
          ],
        }),
        input,
      ),
    ).toEqual([]);
    expect(
      parseSupervision(
        JSON.stringify({
          groups: [
            group({
              destination: { kind: "new", name: "Release engineering" },
            }),
          ],
        }),
        input,
      ),
    ).toEqual([]);
    expect(
      parseSupervision(
        JSON.stringify({ groups: [group({ threadIds: ["r1", "r1"] })] }),
        input,
      ),
    ).toEqual([]);
  });
  it("preserves manual authority and refuses a merge with a protected root", () => {
    const protectedInput: SupervisionInput = {
      ...input,
      workstreams: input.workstreams.map((w) =>
        w.id === "platform"
          ? {
              ...w,
              roots: w.roots.map((root) =>
                root.id === "r2" ? { ...root, eligible: false } : root,
              ),
            }
          : w,
      ),
    };
    expect(
      parseSupervision(JSON.stringify({ groups: [group()] }), protectedInput),
    ).toEqual([]);
    expect(
      parseSupervision(
        JSON.stringify({
          groups: [existing("releases", ["r1", "r2", "r3", "r4"])],
        }),
        protectedInput,
      ),
    ).toEqual([]);
  });
  it("attaches evidence revisions to validated action instructions", () => {
    const [action] = parseSupervision(
      JSON.stringify({ groups: [group()] }),
      input,
    );
    expect(action?.expectedRevisions).toEqual({ r1: 11, r2: 12 });
  });
});
