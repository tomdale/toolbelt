import { describe, expect, it } from "vitest";
import { buildReview } from "../../src/app/page/organize-review.ts";
import type { LiveOrganization } from "../../src/server/contract.ts";

const sampleOrg: LiveOrganization = {
  status: "idle",
  progress: null,
  error: null,
  lastUpdatedAt: 100,
  groups: [
    {
      key: "bb",
      sectionId: "sec_bb",
      name: "bb",
      description: "Core BB application",
      activeCount: 1,
      completedCount: 1,
      totalCount: 2,
      roots: [
        {
          id: "r1",
          title: "Ship docs",
          completed: false,
          identityId: "bb",
          identityLabel: "bb",
          provenance: "manual",
          reason: "Manually assigned to bb; grouped in bb.",
        },
        {
          id: "r2",
          title: "Fix build",
          completed: true,
          identityId: "bb",
          identityLabel: "bb",
          provenance: "automatic",
          reason: "Completed task; retained in bb.",
        },
      ],
    },
    {
      key: "docs",
      sectionId: "sec_docs",
      name: "Docs",
      description: "Docs work",
      activeCount: 1,
      completedCount: 0,
      totalCount: 1,
      roots: [
        {
          id: "r3",
          title: "API reference",
          completed: false,
          identityId: "docs",
          identityLabel: "Docs",
          provenance: "automatic",
          reason: "Classified as Docs.",
        },
      ],
    },
  ],
  unresolved: [
    {
      id: "u1",
      title: "Loose idea",
      completed: false,
      evidence: "hash123",
      reason: "Unresolved identity; remains unfiled.",
    },
  ],
  counts: {
    activeRoots: 2,
    completedRoots: 1,
    totalRoots: 3,
    unresolvedRoots: 1,
    activeWorkstreams: 2,
  },
};

describe("buildReview", () => {
  const review = buildReview(sampleOrg, (id) => (id === "r1" ? 4 : 0));

  it("builds review groups for derived workstreams and unfiled tasks", () => {
    expect(review.groups.map((g) => g.name)).toEqual(["bb", "Docs", "Unfiled"]);
    expect(review.summary.tasks).toBe(3);
    expect(review.summary.currentTasks).toBe(2);
    expect(review.summary.completedTasks).toBe(1);
    expect(review.summary.unresolvedTasks).toBe(1);
    expect(review.summary.childThreads).toBe(4);
  });

  it("maps task retention, completion, and canonical identities accurately", () => {
    const bbGroup = review.groups.find((g) => g.name === "bb")!;
    expect(bbGroup.staying).toHaveLength(2);

    const r1 = bbGroup.staying.find((t) => t.id === "r1")!;
    expect(r1.completed).toBe(false);
    expect(r1.provenance).toBe("manual");
    expect(r1.children).toBe(4);

    const r2 = bbGroup.staying.find((t) => t.id === "r2")!;
    expect(r2.completed).toBe(true);
    expect(r2.retained).toBe(true);

    const unfiledGroup = review.groups.find((g) => g.name === "Unfiled")!;
    expect(unfiledGroup.staying).toHaveLength(1);
    expect(unfiledGroup.staying[0]!.identityStatus).toBe("unresolved");
  });
});
