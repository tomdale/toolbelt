import { describe, expect, it } from "vitest";
import {
  appliedCopy,
  detectProposals,
  pendingCopy,
  proposalKey,
  snoozeKey,
  type EvolutionRoot,
} from "../../src/domain/evolution.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = 1000 * DAY;
const workstreams = [
  { id: "plug", name: "BB & plugins", aliases: [] },
  { id: "recap", name: "BB Recap", aliases: ["Recap"] },
  { id: "empty", name: "Lighthouse", aliases: [] },
];
const root = (
  id: string,
  sectionId: string | null,
  subject: string | null,
  overrides: Partial<EvolutionRoot> = {},
): EvolutionRoot => ({
  id,
  sectionId,
  subject,
  active: true,
  lastActiveAt: now - DAY,
  userMovedAt: null,
  ...overrides,
});
// A workstream with a clear core subject, so secondary subjects can spin out.
const core = ["c1", "c2", "c3", "c4"].map((id) => root(id, "plug", "BB"));
const newProduct = (name: string): Partial<EvolutionRoot> => ({
  drift: { workstream: null, newName: name, confidence: "high" },
});
const detect = (roots: EvolutionRoot[], extra = {}) =>
  detectProposals(roots, workstreams, {
    now,
    sensitivity: "responsive",
    ...extra,
  });

describe("spin-out", () => {
  it("proposes a secondary subject with two roots, one of them active", () => {
    const [p] = detect([
      ...core,
      root("w1", "plug", "Workstreams", newProduct("Workstreams")),
      root("w2", "plug", "Workstreams", {
        ...newProduct("Workstreams"),
        active: false,
      }),
    ]);
    expect(p).toMatchObject({
      kind: "spin-out",
      newName: "Workstreams",
      sourceSectionId: "plug",
      threadIds: ["w1"],
      evidenceCount: 2,
    });
  });

  it("does not spin out a repeated subject without independent ownership evidence", () => {
    expect(
      detect([
        ...core,
        root("w1", "plug", "Workstreams"),
        root("w2", "plug", "Workstreams"),
      ]),
    ).toEqual([]);
  });

  it("does not spin out the current product when a vague subject repeats", () => {
    const streams = [
      { id: "specific", name: "Workstreams", aliases: [] },
      { id: "general", name: "BB & plugins", aliases: [] },
    ];
    expect(
      detectProposals(
        [
          root("w1", "specific", "Workstreams"),
          root("w2", "specific", "Workstreams"),
          root("w3", "specific", "BB"),
          root("b1", "general", "BB"),
        ],
        streams,
        { now, sensitivity: "responsive" },
      ),
    ).toEqual([]);
  });

  it("needs more roots at lower sensitivity and ignores old evidence", () => {
    const roots = [
      ...core,
      root("w1", "plug", "Workstreams", newProduct("Workstreams")),
      root("w2", "plug", "Workstreams", newProduct("Workstreams")),
    ];
    expect(detect(roots, { sensitivity: "balanced" })).toEqual([]);
    expect(
      detect([
        ...core,
        root("w1", "plug", "Workstreams", newProduct("Workstreams")),
        root("w2", "plug", "Workstreams", {
          ...newProduct("Workstreams"),
          lastActiveAt: now - 61 * DAY,
        }),
      ]),
    ).toEqual([]);
  });

  it("never spins out without an active root, the core, or most of a workstream", () => {
    expect(
      detect([
        ...core,
        root("w1", "plug", "Workstreams", {
          ...newProduct("Workstreams"),
          active: false,
        }),
        root("w2", "plug", "Workstreams", {
          ...newProduct("Workstreams"),
          active: false,
        }),
      ]),
    ).toEqual([]);
    expect(detect(core)).toEqual([]);
    expect(
      detect([
        root("c1", "plug", "BB"),
        root("w1", "plug", "Workstreams", newProduct("Workstreams")),
        root("w2", "plug", "Workstreams", newProduct("Workstreams")),
      ]),
    ).toEqual([]);
  });

  it("excludes roots the user moved in the last 14 days", () => {
    expect(
      detect([
        ...core,
        root("w1", "plug", "Workstreams", {
          ...newProduct("Workstreams"),
          userMovedAt: now - 2 * DAY,
        }),
        root("w2", "plug", "Workstreams", newProduct("Workstreams")),
      ]),
    ).toEqual([]);
  });
});

describe("move and merge", () => {
  it("moves roots whose subject names another live workstream or alias", () => {
    const [p] = detect([
      ...core,
      root("r1", "plug", "Recap", {
        drift: { workstream: "BB Recap", confidence: "high" },
      }),
      root("r0", "recap", "BB Recap"),
    ]);
    expect(p).toMatchObject({
      kind: "move",
      targetSectionId: "recap",
      subject: "BB Recap",
      threadIds: ["r1"],
    });
  });

  it("does not move specific product work into a broad applicable workstream", () => {
    const streams = [
      { id: "workstreams", name: "Workstreams", aliases: [] },
      { id: "bb", name: "BB & plugins", aliases: [] },
    ];
    const roots = [
      root("specific", "workstreams", "BB & plugins"),
      root("general", "bb", "BB & plugins"),
    ];
    expect(
      detectProposals(roots, streams, { now, sensitivity: "responsive" }),
    ).toEqual([]);
    expect(
      detectProposals(
        [
          {
            ...roots[0]!,
            drift: { workstream: "BB & plugins", confidence: "medium" },
          },
          roots[1]!,
        ],
        streams,
        { now, sensitivity: "responsive" },
      ),
    ).toEqual([]);
    expect(
      detectProposals(
        [
          {
            ...roots[0]!,
            drift: { workstream: "BB & plugins", confidence: "high" },
          },
          roots[1]!,
        ],
        streams,
        { now, sensitivity: "responsive" },
      )[0],
    ).toMatchObject({
      kind: "merge",
      sourceSectionId: "workstreams",
      targetSectionId: "bb",
      threadIds: ["specific"],
    });
  });

  it("uses explicit drift even when the extracted subject names another product", () => {
    const [proposal] = detect([
      ...core,
      root("r0", "recap", "BB Recap"),
      root("mismatch", "plug", "Workstreams", {
        drift: { workstream: "BB Recap", confidence: "high" },
      }),
    ]);
    expect(proposal).toMatchObject({
      kind: "move",
      sourceSectionId: "plug",
      targetSectionId: "recap",
      threadIds: ["mismatch"],
    });
  });

  it("doesn't move into a workstream with no threads", () => {
    expect(detect([...core, root("d1", "plug", "Lighthouse")])).toEqual([]);
  });

  it("merges when every active root of a workstream belongs elsewhere", () => {
    const [p] = detect([
      ...core,
      root("r1", "recap", "BB"),
      root("r2", "recap", "BB & plugins", {
        drift: { workstream: "BB & plugins", confidence: "high" },
      }),
    ]);
    // Subjects differ ("BB" vs "BB & plugins"); only the named one matches.
    expect(p?.kind).toBe("move");
    const [merge] = detect([
      ...core,
      root("r1", "recap", "BB & plugins", {
        drift: { workstream: "BB & plugins", confidence: "high" },
      }),
      root("r2", "recap", "BB & plugins", {
        drift: { workstream: "BB & plugins", confidence: "high" },
      }),
    ]);
    expect(merge).toMatchObject({
      kind: "merge",
      sourceSectionId: "recap",
      targetSectionId: "plug",
    });
  });
});

describe("anti-churn", () => {
  const roots = [
    ...core,
    root("w1", "plug", "Workstreams", newProduct("Workstreams")),
    root("w2", "plug", "Workstreams", newProduct("Workstreams")),
    root("d1", "plug", "Dockyard", newProduct("Dockyard")),
    root("d2", "plug", "Dockyard", newProduct("Dockyard")),
    root("r1", "recap", "BB & plugins"),
    root("x1", "recap", "Recap Eval", newProduct("Recap Eval")),
    root("x2", "recap", "Recap Eval", newProduct("Recap Eval")),
  ];

  it("keeps one open proposal per workstream and three overall", () => {
    const found = detect(roots);
    expect(new Set(found.map((p) => p.sourceSectionId)).size).toBe(
      found.length,
    );
    expect(detect(roots, { openCount: 3 })).toEqual([]);
    expect(
      detect(roots, { openSources: new Set(["plug"]) }).every(
        (p) => p.sourceSectionId !== "plug",
      ),
    ).toBe(true);
  });

  it("skips raised keys without letting them take a slot", () => {
    const all = detect(roots, { capped: false });
    const first = detect(roots)[0]!;
    const next = detect(roots, { exclude: new Set([first.key]) });
    expect(next.some((p) => p.key === first.key)).toBe(false);
    expect(next.some((p) => p.sourceSectionId === first.sourceSectionId)).toBe(
      all.filter((p) => p.sourceSectionId === first.sourceSectionId).length > 1,
    );
  });

  it("brings a dismissed subject back only after two more roots", () => {
    const key = proposalKey("spin-out", "plug", "Workstreams");
    const snoozed = new Map([[snoozeKey(key), 2]]);
    const few = [
      ...core,
      root("w1", "plug", "Workstreams", newProduct("Workstreams")),
      root("w2", "plug", "Workstreams", newProduct("Workstreams")),
      root("w3", "plug", "Workstreams", {
        ...newProduct("Workstreams"),
        active: false,
      }),
    ];
    expect(detect(few, { snoozed })).toEqual([]);
    const more = [
      ...few,
      root("w4", "plug", "Workstreams", {
        ...newProduct("Workstreams"),
        active: false,
      }),
    ];
    expect(detect(more, { snoozed })[0]?.key).toBe(key);
  });
});

describe("banner copy", () => {
  it("matches the specified wording", () => {
    expect(pendingCopy("spin-out", "BB Recap", 2, "BB & plugins")).toEqual({
      text: "This thread and 2 others look like BB Recap work. Spin out a BB Recap workstream?",
      accept: "Spin out",
    });
    expect(appliedCopy("BB & plugins", "BB Recap")).toBe(
      "Moved from BB & plugins → BB Recap",
    );
    expect(pendingCopy("move", "BB Recap", 0, "Unsorted").text).toBe(
      "This thread looks like BB Recap work. Move to BB Recap?",
    );
  });
});
