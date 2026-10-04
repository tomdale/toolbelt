import type { LiveOrganization } from "../../server/contract.ts";
import { compareGroupNames } from "../../domain/group-name-order.ts";

export type Placement = string | null;

export type ReviewTask = {
  id: string;
  title: string;
  /** Live child threads that follow this root. */
  children: number;
  from: Placement;
  fromName: string;
  to: Placement;
  toName: string;
  /** The organizer's stated reason, shown only for debugging. */
  reason: string;
  /** The organizer suggested a move that Apply will not perform. */
  declined: boolean;
  /** Canonical identity (specific feature path), e.g. "Toolbelt · Workstreams · Organize". */
  identityLabel: string | null;
  /** Whether the task is assigned or unresolved. */
  identityStatus: "assigned" | "unresolved";
  /** How the identity was determined: manual user selection or automatic classification. */
  provenance: "manual" | "automatic" | null;
  /** Safe bounded evidence hash used for classification. */
  evidence: string | null;
  /** Whether the task is a completed (done) task. */
  completed: boolean;
  /** Whether this task was retained in its current home due to being unresolved or completed. */
  retained: boolean;
};

export type ReviewGroup = {
  /** Stable React key; the placement, or `unfiled`. */
  key: string;
  placement: Placement;
  name: string;
  kind: "existing" | "new" | "unfiled" | "removed";
  renamedFrom: string | null;
  description: string | null;
  /** The stored description Apply replaces, when it differs. */
  previousDescription: string | null;
  before: number;
  after: number;
  incoming: ReviewTask[];
  outgoing: ReviewTask[];
  staying: ReviewTask[];
  /** Archived threads a removed workstream still holds; BB keeps them. */
  archivedThreads: number;
};

export type ReviewSummary = {
  tasks: number;
  childThreads: number;
  moving: number;
  movingChildren: number;
  staying: number;
  created: number;
  renamed: number;
  removed: number;
  declined: number;
  /** Workstreams holding tasks after Apply, Unfiled excluded. */
  workstreamsAfter: number;
  /** Open counted tasks driving grouping (active tasks). */
  currentTasks: number;
  /** Completed retained tasks. */
  completedTasks: number;
  /** Unresolved tasks. */
  unresolvedTasks: number;
};

export type Review = {
  summary: ReviewSummary;
  groups: ReviewGroup[];
  removed: ReviewGroup[];
  moves: ReviewTask[];
  isStale: boolean;
};

export function buildReview(
  org: LiveOrganization,
  childrenOf: (rootId: string) => number = () => 0,
): Review {
  const groups: ReviewGroup[] = [];

  for (const g of org.groups) {
    const tasks: ReviewTask[] = g.roots.map((r) => ({
      id: r.id,
      title: r.title || "Untitled",
      children: childrenOf(r.id),
      from: g.sectionId,
      fromName: g.name,
      to: g.sectionId,
      toName: g.name,
      reason: r.reason,
      declined: false,
      identityLabel: r.identityLabel,
      identityStatus: "assigned",
      provenance: r.provenance,
      evidence: null,
      completed: r.completed,
      retained: r.completed || r.reason.includes("retained"),
    }));

    groups.push({
      key: g.key,
      placement: g.sectionId,
      name: g.name,
      kind: "existing",
      renamedFrom: null,
      description: g.description,
      previousDescription: null,
      before: g.totalCount,
      after: g.totalCount,
      incoming: [],
      outgoing: [],
      staying: tasks,
      archivedThreads: 0,
    });
  }

  if (org.unresolved.length > 0) {
    const unfiledTasks: ReviewTask[] = org.unresolved.map((u) => ({
      id: u.id,
      title: u.title || "Untitled",
      children: childrenOf(u.id),
      from: null,
      fromName: "Unfiled",
      to: null,
      toName: "Unfiled",
      reason: u.reason,
      declined: false,
      identityLabel: null,
      identityStatus: "unresolved",
      provenance: null,
      evidence: u.evidence,
      completed: u.completed,
      retained: false,
    }));

    groups.push({
      key: "unfiled",
      placement: null,
      name: "Unfiled",
      kind: "unfiled",
      renamedFrom: null,
      description: "Tasks with unresolved identities",
      previousDescription: null,
      before: org.unresolved.length,
      after: org.unresolved.length,
      incoming: [],
      outgoing: [],
      staying: unfiledTasks,
      archivedThreads: 0,
    });
  }

  groups.sort((a, b) => compareGroupNames(a.name, b.name));

  const totalTasks = org.counts.totalRoots;
  const childThreads = groups.reduce(
    (sum, g) => sum + g.staying.reduce((s, t) => s + t.children, 0),
    0,
  );

  return {
    summary: {
      tasks: totalTasks,
      childThreads,
      moving: 0,
      movingChildren: 0,
      staying: totalTasks,
      created: 0,
      renamed: 0,
      removed: 0,
      declined: 0,
      workstreamsAfter: org.counts.activeWorkstreams,
      currentTasks: org.counts.activeRoots,
      completedTasks: org.counts.completedRoots,
      unresolvedTasks: org.counts.unresolvedRoots,
    },
    groups,
    removed: [],
    moves: [],
    isStale: false,
  };
}
