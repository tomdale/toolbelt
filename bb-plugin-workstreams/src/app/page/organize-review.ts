/**
 * The Organize review model: a saved organizing preview restated as what
 * Apply would do. Placement is a native section id, `new:<key>` for a
 * workstream Apply would create, or null for Unfiled. Only accepted moves
 * count as moving, because Apply performs only those; a declined move leaves
 * its task where it is.
 *
 * Counts are task roots. A root's child threads inherit its workstream
 * (SPEC I2), so they are reported separately as the threads that follow it.
 */
import type { BootstrapState } from "../../server/bootstrap.ts";
import { compareGroupNames } from "../../domain/group-name-order.ts";

type Preview = NonNullable<BootstrapState["preview"]>;
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
};

export type Review = {
  summary: ReviewSummary;
  /** Workstreams that exist after Apply, A–Z, with Unfiled last. */
  groups: ReviewGroup[];
  /** Workstreams Apply deletes, A–Z. */
  removed: ReviewGroup[];
  /** Every task Apply moves, by destination then title. */
  moves: ReviewTask[];
};

const newPlacement = (key: string) => `new:${key}`;

export function buildReview(
  state: Pick<BootstrapState, "roots" | "mapSnapshot">,
  preview: Preview,
  childrenOf: (rootId: string) => number = () => 0,
): Review {
  const snapshot = new Map(state.mapSnapshot.map((r) => [r.sectionId, r]));
  const proposed = new Map(
    preview.workstreams.map((w) => [w.sectionId ?? newPlacement(w.key), w]),
  );
  const nameOf = (placement: Placement) =>
    placement === null
      ? "Unfiled"
      : (proposed.get(placement)?.name ??
        snapshot.get(placement)?.name ??
        "Unknown workstream");
  const currentNameOf = (placement: Placement) =>
    placement === null
      ? "Unfiled"
      : (snapshot.get(placement)?.name ?? nameOf(placement));
  const moveOf = new Map(preview.moves.map((m) => [m.threadId, m]));
  const reasonOf = new Map(
    preview.assignments.map((a) => [a.threadId, a.reason]),
  );

  const tasks: ReviewTask[] = state.roots.map((root) => {
    const move = moveOf.get(root.id);
    const from = root.sectionId;
    const to = move?.accepted ? move.to : from;
    return {
      id: root.id,
      title: root.title || move?.title || "Untitled",
      children: childrenOf(root.id),
      from,
      fromName: move?.fromName ?? currentNameOf(from),
      to,
      toName: move?.accepted ? move.toName : nameOf(to),
      reason: move?.reason ?? reasonOf.get(root.id) ?? "",
      declined: Boolean(move && !move.accepted),
    };
  });
  const byTitle = (a: ReviewTask, b: ReviewTask) =>
    a.title.localeCompare(b.title);

  const removals = new Map(preview.removals.map((r) => [r.sectionId, r]));
  const renames = new Map(preview.renames.map((r) => [r.sectionId, r.from]));
  const placements = new Set<Placement>([
    ...proposed.keys(),
    ...snapshot.keys(),
    ...removals.keys(),
    ...tasks.flatMap((t) => [t.from, t.to]),
  ]);
  const all: ReviewGroup[] = [];
  for (const placement of placements) {
    const incoming = tasks.filter(
      (t) => t.to === placement && t.from !== placement,
    );
    const outgoing = tasks.filter(
      (t) => t.from === placement && t.to !== placement,
    );
    const staying = tasks.filter(
      (t) => t.from === placement && t.to === placement,
    );
    const before = outgoing.length + staying.length;
    const after = incoming.length + staying.length;
    const home = placement === null ? undefined : proposed.get(placement);
    const stored = placement === null ? undefined : snapshot.get(placement);
    const removal = placement === null ? undefined : removals.get(placement);
    const kind: ReviewGroup["kind"] =
      placement === null
        ? "unfiled"
        : removal
          ? "removed"
          : stored
            ? "existing"
            : "new";
    // A proposed new workstream with no accepted moves is never created.
    if (kind === "new" && after === 0) continue;
    if (kind === "unfiled" && before === 0 && after === 0) continue;
    const description = home?.description ?? stored?.description ?? null;
    const previous = stored?.description ?? null;
    all.push({
      key: placement ?? "unfiled",
      placement,
      name: nameOf(placement),
      kind,
      renamedFrom: placement === null ? null : (renames.get(placement) ?? null),
      description,
      previousDescription:
        home && stored && previous !== home.description ? previous : null,
      before,
      after,
      incoming: incoming.sort(byTitle),
      outgoing: outgoing.sort(byTitle),
      staying: staying.sort(byTitle),
      archivedThreads: removal?.archivedThreads.length ?? 0,
    });
  }
  const lexical = (a: ReviewGroup, b: ReviewGroup) =>
    compareGroupNames(a.name, b.name);
  const groups = all
    .filter((g) => g.kind !== "removed" && g.kind !== "unfiled")
    .sort(lexical);
  const unfiled = all.find((g) => g.kind === "unfiled");
  if (unfiled) groups.push(unfiled);
  const removed = all.filter((g) => g.kind === "removed").sort(lexical);
  const moves = tasks
    .filter((t) => t.from !== t.to)
    .sort(
      (a, b) =>
        (a.to === null ? 1 : 0) - (b.to === null ? 1 : 0) ||
        compareGroupNames(a.toName, b.toName) ||
        byTitle(a, b),
    );
  const created = groups.filter((g) => g.kind === "new").length;
  return {
    summary: {
      tasks: tasks.length,
      childThreads: tasks.reduce((n, t) => n + t.children, 0),
      moving: moves.length,
      movingChildren: moves.reduce((n, t) => n + t.children, 0),
      staying: tasks.length - moves.length,
      created,
      renamed: preview.renames.filter((r) => !removals.has(r.sectionId)).length,
      removed: removed.length,
      declined: tasks.filter((t) => t.declined).length,
      workstreamsAfter: groups.filter((g) => g.kind !== "unfiled" && g.after)
        .length,
    },
    groups,
    removed,
    moves,
  };
}
