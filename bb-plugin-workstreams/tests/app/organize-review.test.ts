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
});
