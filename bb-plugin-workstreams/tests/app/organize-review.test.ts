import { describe, expect, it } from "vitest";
import { buildReview } from "../../src/app/page/organize-review.ts";
import type { BootstrapState } from "../../src/server/bootstrap.ts";

type Preview = NonNullable<BootstrapState["preview"]>;

const record = (sectionId: string, name: string, description: string) => ({
  sectionId,
  name,
  description,
  aliases: [],
  descriptionSource: "generated" as const,
});
const home = (
  key: string,
  sectionId: string | null,
  name: string,
  description = `${name} work`,
) => ({ key, sectionId, name, description, aliases: [] });

const state = {
  roots: [
    { id: "r1", title: "Ship docs", sectionId: "sec_old" },
    { id: "r2", title: "Fix build", sectionId: "sec_old" },
    { id: "r3", title: "Loose idea", sectionId: null },
  ],
  mapSnapshot: [
    record("sec_old", "BB", "BB work"),
    record("sec_quiet", "Quiet", "Quiet work"),
  ],
};
const preview: Preview = {
  workstreams: [
    home("bb", "sec_old", "bb", "Core BB application"),
    home("docs", null, "Docs"),
    home("unused", null, "Abandoned idea"),
  ],
  creates: [],
  renames: [{ sectionId: "sec_old", from: "BB", to: "bb" }],
  moves: [
    {
      threadId: "r1",
      title: "Ship docs",
      from: "sec_old",
      fromName: "BB",
      to: "new:docs",
      toName: "Docs",
      reason: "docs",
      accepted: true,
    },
    {
      threadId: "r3",
      title: "Loose idea",
      from: null,
      fromName: "Unfiled",
      to: "new:unused",
      toName: "Abandoned idea",
      reason: "idea",
      accepted: false,
    },
  ],
  assignments: [],
  removals: [],
};

describe("buildReview", () => {
  const review = buildReview(state, preview, (id) => (id === "r1" ? 4 : 0));

  it("lists resulting workstreams A–Z with Unfiled last, omitting homes Apply would not create", () => {
    expect(review.groups.map((g) => g.name)).toEqual([
      "bb",
      "Docs",
      "Quiet",
      "Unfiled",
    ]);
  });

  it("states renames and replaced descriptions against the stored map", () => {
    const bb = review.groups.find((g) => g.placement === "sec_old")!;
    expect(bb.renamedFrom).toBe("BB");
    expect(bb.description).toBe("Core BB application");
    expect(bb.previousDescription).toBe("BB work");
    expect([bb.before, bb.after]).toEqual([2, 1]);
    expect(bb.outgoing.map((t) => t.toName)).toEqual(["Docs"]);
    const quiet = review.groups.find((g) => g.placement === "sec_quiet")!;
    expect([quiet.before, quiet.after, quiet.previousDescription]).toEqual([
      0,
      0,
      null,
    ]);
  });

  it("counts task roots apart from the child threads that follow them", () => {
    expect(review.summary).toMatchObject({
      tasks: 3,
      childThreads: 4,
      moving: 1,
      movingChildren: 4,
      staying: 2,
      created: 1,
      renamed: 1,
      removed: 0,
      declined: 1,
      workstreamsAfter: 2,
    });
    expect(review.moves.map((t) => [t.title, t.fromName, t.toName])).toEqual([
      ["Ship docs", "BB", "Docs"],
    ]);
    const unfiled = review.groups.at(-1)!;
    expect(unfiled.staying.map((t) => [t.title, t.declined])).toEqual([
      ["Loose idea", true],
    ]);
  });

  it("displays specific feature path independently of broader proposed workstream", () => {
    const semanticPreview: Preview = {
      ...preview,
      identities: {
        r1: {
          threadId: "r1",
          entityId: "ent_review",
          status: "assigned",
          provenance: "automatic",
          label: "Toolbelt · Workstreams · Organize Review",
          ancestorIds: ["ent_toolbelt", "ent_workstreams"],
          evidence: "sha256-evidence-hash",
          inheritedFrom: null,
        },
      },
    };
    const semanticReview = buildReview(state, semanticPreview);
    const moving = semanticReview.moves[0]!;
    expect(moving.title).toBe("Ship docs");
    // Specific canonical identity path is independent of the proposed workstream destination
    expect(moving.identityLabel).toBe(
      "Toolbelt · Workstreams · Organize Review",
    );
    expect(moving.toName).toBe("Docs");
    expect(moving.provenance).toBe("automatic");
    expect(moving.evidence).toBe("sha256-evidence-hash");
  });

  it("accurately labels unresolved task retained in current home", () => {
    const semanticState = {
      ...state,
      roots: [
        { id: "r1", title: "Ship docs", sectionId: "sec_old" },
        { id: "r2", title: "Unresolved task", sectionId: "sec_old" },
      ],
    };
    const semanticPreview: Preview = {
      ...preview,
      moves: [],
      assignments: [
        {
          threadId: "r1",
          workstream: "sec_old",
          reason: "Classified as BB.",
        },
        {
          threadId: "r2",
          workstream: "sec_old",
          reason: "Unresolved identity; retained in BB.",
        },
      ],
      identities: {
        r1: {
          threadId: "r1",
          entityId: "ent_bb",
          status: "assigned",
          provenance: "manual",
          label: "BB",
          ancestorIds: [],
          evidence: null,
          inheritedFrom: null,
        },
        r2: {
          threadId: "r2",
          entityId: null,
          status: "unresolved",
          provenance: null,
          label: null,
          ancestorIds: [],
          evidence: null,
          inheritedFrom: null,
        },
      },
    };
    const semanticReview = buildReview(semanticState, semanticPreview);
    const bbGroup = semanticReview.groups.find(
      (g) => g.placement === "sec_old",
    )!;
    const unresolvedTask = bbGroup.staying.find((t) => t.id === "r2")!;
    expect(unresolvedTask.identityStatus).toBe("unresolved");
    expect(unresolvedTask.identityLabel).toBeNull();
    expect(unresolvedTask.retained).toBe(true);
    expect(unresolvedTask.fromName).toBe("BB");
    expect(unresolvedTask.reason).toBe(
      "Unresolved identity; retained in BB.",
    );
  });

  it("distinguishes counted current tasks from retained completed roots", () => {
    const semanticState = {
      roots: [
        { id: "t_active", title: "Active work", sectionId: "sec_old", completed: false },
        { id: "t_done", title: "Done work", sectionId: "sec_old", completed: true },
        { id: "t_unresolved", title: "Unclear work", sectionId: null, completed: false },
      ],
      mapSnapshot: state.mapSnapshot,
    };
    const semanticPreview: Preview = {
      ...preview,
      completedRoots: ["t_done"],
      identities: {
        t_active: {
          threadId: "t_active",
          entityId: "ent_bb",
          status: "assigned",
          provenance: "automatic",
          label: "BB",
          ancestorIds: [],
          evidence: "hash",
          inheritedFrom: null,
        },
        t_done: {
          threadId: "t_done",
          entityId: "ent_bb",
          status: "assigned",
          provenance: "automatic",
          label: "BB",
          ancestorIds: [],
          evidence: "hash",
          inheritedFrom: null,
        },
        t_unresolved: {
          threadId: "t_unresolved",
          entityId: null,
          status: "unresolved",
          provenance: null,
          label: null,
          ancestorIds: [],
          evidence: null,
          inheritedFrom: null,
        },
      },
    };
    const semanticReview = buildReview(semanticState, semanticPreview);
    expect(semanticReview.summary.tasks).toBe(3);
    expect(semanticReview.summary.currentTasks).toBe(2);
    expect(semanticReview.summary.completedTasks).toBe(1);
    expect(semanticReview.summary.unresolvedTasks).toBe(1);

    const bbGroup = semanticReview.groups.find(
      (g) => g.placement === "sec_old",
    )!;
    const completedTask = bbGroup.staying.find((t) => t.id === "t_done")!;
    expect(completedTask.completed).toBe(true);
  });

  it("marks preview stale and records isStale when catalog revision changed", () => {
    const stalePreview: Preview = {
      ...preview,
      isStale: true,
      catalogRevision: 1,
    };
    const semanticReview = buildReview(state, stalePreview);
    expect(semanticReview.isStale).toBe(true);
  });

  it("provides meaningful no-change review when all tasks remain in their workstreams", () => {
    const noChangePreview: Preview = {
      ...preview,
      moves: [],
      assignments: [
        { threadId: "r1", workstream: "sec_old", reason: "Classified as BB." },
        { threadId: "r2", workstream: "sec_old", reason: "Classified as BB." },
      ],
      creates: [],
      renames: [],
      removals: [],
    };
    const semanticState = {
      roots: [
        { id: "r1", title: "Task 1", sectionId: "sec_old" },
        { id: "r2", title: "Task 2", sectionId: "sec_old" },
      ],
      mapSnapshot: [record("sec_old", "BB", "BB work")],
    };
    const reviewResult = buildReview(semanticState, noChangePreview);
    expect(reviewResult.summary.moving).toBe(0);
    expect(reviewResult.summary.staying).toBe(2);
    expect(reviewResult.moves).toHaveLength(0);
    expect(reviewResult.groups.find((g) => g.placement === "sec_old")?.staying).toHaveLength(2);
  });
});
