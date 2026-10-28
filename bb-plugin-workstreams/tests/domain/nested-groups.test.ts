import { describe, expect, it } from "vitest";
import {
  arrangeGroups,
  focusedSections,
  nestGroups,
  sharedTopicId,
  type WorkstreamNode,
  type WorkstreamTopics,
} from "../../src/domain/groups.ts";
import { DAY_MS, projectWorkstreams } from "../../src/domain/project.ts";
import { planDrop } from "../../src/app/sidebar/drop.ts";
import { EMPTY_ORDER } from "../../src/domain/order.ts";
import { thread, type TestThread } from "./fixtures.ts";

const now = 100 * DAY_MS;
const entities = [
  { id: "va", name: "Beacon", parentId: null },
  { id: "auto", name: "Automations", parentId: "va" },
  { id: "alerts", name: "Alert Investigations", parentId: "auto" },
  { id: "cli", name: "CLI", parentId: "auto" },
  { id: "review", name: "Code Review", parentId: "va" },
  { id: "ws", name: "Workstreams", parentId: null },
];
const topics = (bindings: Record<string, string>): WorkstreamTopics => ({
  entities,
  bindings,
});

/** Labels as an indented outline, so a test reads like the sidebar. */
function outline(nodes: readonly WorkstreamNode<TestThread>[], depth = 0) {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${"  ".repeat(depth)}${node.label} (${node.total})`);
    lines.push(...outline(node.subgroups, depth + 1));
  }
  return lines;
}

describe("nestGroups", () => {
  it("nests a workstream under the workstream of its parent topic", () => {
    const projection = projectWorkstreams(
      [
        thread("a1", { sectionId: "sec_auto" }),
        thread("a2", { sectionId: "sec_auto" }),
        thread("i1", { sectionId: "sec_alerts" }),
        thread("w1", { sectionId: "sec_ws" }),
      ],
      [
        { id: "sec_auto", name: "Beacon: Automations" },
        {
          id: "sec_alerts",
          name: "Beacon: Automations: Alert Investigations",
        },
        { id: "sec_ws", name: "Workstreams" },
      ],
      { now },
    );
    const nodes = nestGroups(
      projection.all,
      topics({ sec_auto: "auto", sec_alerts: "alerts", sec_ws: "ws" }),
    );
    expect(outline(nodes)).toEqual([
      "Beacon: Automations (3)",
      "  Alert Investigations (1)",
      "Workstreams (1)",
    ]);
    expect(nodes[0]!.rows.map((row) => row.thread.id).sort()).toEqual([
      "a1",
      "a2",
    ]);
    expect(nodes[0]!.sectionIds).toEqual(["sec_auto", "sec_alerts"]);
  });

  it("heads sibling workstreams with the topic they share", () => {
    const projection = projectWorkstreams(
      [
        thread("i1", { sectionId: "sec_alerts" }),
        thread("c1", { sectionId: "sec_cli" }),
        thread("c2", { sectionId: "sec_cli" }),
      ],
      [
        {
          id: "sec_alerts",
          name: "Beacon: Automations: Alert Investigations",
        },
        { id: "sec_cli", name: "Beacon: Automations: CLI" },
      ],
      { now },
    );
    const [top, ...rest] = nestGroups(
      projection.all,
      topics({ sec_alerts: "alerts", sec_cli: "cli" }),
    );
    expect(rest).toEqual([]);
    expect(outline([top!])).toEqual([
      "Beacon: Automations (3)",
      "  Alert Investigations (1)",
      "  CLI (2)",
    ]);
    expect(top!.id).toBe(sharedTopicId("auto"));
    expect(top!.hasSection).toBe(false);
    expect(top!.topicId).toBe("auto");
    expect(top!.rows).toEqual([]);
  });

  it("follows the topic tree past one level and labels skipped topics", () => {
    const projection = projectWorkstreams(
      [
        thread("i1", { sectionId: "sec_alerts" }),
        thread("c1", { sectionId: "sec_cli" }),
        thread("r1", { sectionId: "sec_review" }),
      ],
      [
        { id: "sec_alerts", name: "A" },
        { id: "sec_cli", name: "C" },
        { id: "sec_review", name: "R" },
      ],
      { now },
    );
    expect(
      outline(
        nestGroups(
          projection.all,
          topics({
            sec_alerts: "alerts",
            sec_cli: "cli",
            sec_review: "review",
          }),
        ),
      ),
    ).toEqual([
      "Beacon (3)",
      "  Automations (2)",
      "    Alert Investigations (1)",
      "    CLI (1)",
      "  Code Review (1)",
    ]);
    expect(
      outline(
        nestGroups(
          projection.all.filter((group) => group.id !== "sec_cli"),
          topics({ sec_alerts: "alerts", sec_review: "review" }),
        ),
      ),
    ).toEqual([
      "Beacon (2)",
      "  Automations: Alert Investigations (1)",
      "  Code Review (1)",
    ]);
  });

  it("leaves a workstream alone without topics or with an unknown topic", () => {
    const projection = projectWorkstreams(
      [thread("a1", { sectionId: "sec_a" })],
      [
        { id: "sec_a", name: "Alpha" },
        { id: "sec_b", name: "Beta" },
      ],
      { now },
    );
    expect(outline(nestGroups(projection.all))).toEqual([
      "Alpha (1)",
      "Beta (0)",
    ]);
    expect(
      outline(nestGroups(projection.all, topics({ sec_a: "gone" }))),
    ).toEqual(["Alpha (1)", "Beta (0)"]);
  });
});

describe("arrangeGroups with topics", () => {
  const sections = [
    { id: "sec_auto", name: "Beacon: Automations" },
    {
      id: "sec_alerts",
      name: "Beacon: Automations: Alert Investigations",
    },
    { id: "sec_ws", name: "Workstreams" },
  ];
  const bindings = topics({
    sec_auto: "auto",
    sec_alerts: "alerts",
    sec_ws: "ws",
  });

  it("focuses, and counts as focused, a whole top-level group", () => {
    const projection = projectWorkstreams(
      [
        thread("a1", { sectionId: "sec_auto", latestAttentionAt: now }),
        thread("i1", { sectionId: "sec_alerts", latestAttentionAt: now }),
        thread("w1", { sectionId: "sec_ws", latestAttentionAt: now }),
      ],
      sections,
      {
        now,
        order: { workstreams: [], threads: {}, prioritized: ["sec_alerts"] },
      },
    );
    const arranged = arrangeGroups(projection, "alphabetical", bindings);
    expect(outline(arranged.pinned)).toEqual([
      "Beacon: Automations (2)",
      "  Alert Investigations (1)",
    ]);
    expect(outline(arranged.populated)).toEqual(["Workstreams (1)"]);
    expect([...focusedSections(arranged, new Set(["sec_alerts"]))]).toEqual([
      "sec_auto",
      "sec_alerts",
    ]);
  });

  it("keeps a group out of Dormant while any part of it is active", () => {
    const projection = projectWorkstreams(
      [
        thread("old", {
          sectionId: "sec_auto",
          latestAttentionAt: now - 60 * DAY_MS,
        }),
        thread("fresh", { sectionId: "sec_alerts", latestAttentionAt: now }),
        thread("w1", {
          sectionId: "sec_ws",
          latestAttentionAt: now - 60 * DAY_MS,
        }),
      ],
      sections,
      { now },
    );
    const arranged = arrangeGroups(projection, "alphabetical", bindings);
    expect(arranged.populated.map((group) => group.label)).toEqual([
      "Beacon: Automations",
    ]);
    expect(arranged.dormant.map((group) => group.label)).toEqual([
      "Workstreams",
    ]);
  });

  it("sorts subgroups by their own labels", () => {
    const projection = projectWorkstreams(
      [
        thread("c1", { sectionId: "sec_cli", latestAttentionAt: now - 2 }),
        thread("i1", { sectionId: "sec_alerts", latestAttentionAt: now - 1 }),
      ],
      [
        { id: "sec_cli", name: "Beacon: Automations: CLI" },
        {
          id: "sec_alerts",
          name: "Beacon: Automations: Alert Investigations",
        },
      ],
      { now },
    );
    const nested = topics({ sec_cli: "cli", sec_alerts: "alerts" });
    expect(
      outline(arrangeGroups(projection, "alphabetical", nested).populated),
    ).toEqual([
      "Beacon: Automations (2)",
      "  Alert Investigations (1)",
      "  CLI (1)",
    ]);
    expect(
      outline(arrangeGroups(projection, "manual", nested).populated),
    ).toEqual([
      "Beacon: Automations (2)",
      "  CLI (1)",
      "  Alert Investigations (1)",
    ]);
  });
});

describe("planDrop with nested groups", () => {
  it("moves a top-level group's sections together", () => {
    const sections = [
      { id: "sec_ws", name: "Workstreams" },
      { id: "sec_alerts", name: "Alerts" },
      { id: "sec_other", name: "Other" },
      { id: "sec_cli", name: "CLI" },
    ];
    const projection = projectWorkstreams([], sections, { now });
    expect(
      planDrop(
        {
          kind: "group",
          groupId: "sec_other",
          overGroupId: sharedTopicId("auto"),
        },
        projection,
        sections,
        EMPTY_ORDER,
        topics({ sec_ws: "ws", sec_alerts: "alerts", sec_cli: "cli" }),
      ),
    ).toEqual({
      reorder: {
        kind: "workstreams",
        ids: ["sec_ws", "sec_other", "sec_alerts", "sec_cli"],
      },
    });
  });
});
