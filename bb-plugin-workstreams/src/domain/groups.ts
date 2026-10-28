/**
 * How the workstream groups are arranged below Up Next, shared by the sidebar
 * and the phone Home screen: focused groups (stored as `prioritized`) lead,
 * the rest follow in the chosen order with populated ones before empty ones,
 * and Unfiled and Dormant sit beside them. While any workstream is focused
 * the rest hide behind a "Show other workstreams" toggle. Pure, so both
 * surfaces agree.
 *
 * Workstreams nest by topic. Each workstream is a BB section bound to one
 * topic, and BB keeps sections flat, so the nesting is drawn here: the
 * workstreams of one product form a single top-level group headed by the
 * most specific topic they all share, and a workstream sits under the
 * nearest topic it shares with another. A shared topic with no workstream of
 * its own becomes a header with no threads of its own. Focus, dormancy, and
 * ordering apply to the top-level group as a whole.
 */
import type { Group, Projection, WorkstreamThread } from "./project.ts";

/** How workstream groups are ordered: by name, by recent activity, or as dragged. */
export type GroupSort = "alphabetical" | "activity" | "manual";

/** The topic tree and the topic each workstream's section is bound to. */
export type WorkstreamTopics = {
  readonly entities: readonly {
    readonly id: string;
    readonly name: string;
    readonly parentId: string | null;
  }[];
  /** Section id → topic id. */
  readonly bindings: Readonly<Record<string, string>>;
};

/**
 * A workstream group with the more specific workstreams nested under it.
 * `rows` are the threads filed in this workstream itself; `total`,
 * `needsYou`, and `lastActiveAt` cover the whole subtree, and the node is
 * `prioritized` when any workstream in it is focused.
 */
export type WorkstreamNode<T extends WorkstreamThread> = Group<T> & {
  /** The topic it shows; null for a section bound to no known topic. */
  readonly topicId: string | null;
  /**
   * The name to show: the full name at the top level, else the topic path
   * below the enclosing group ("Alert Investigations").
   */
  readonly label: string;
  /** False for a shared topic's header, which no BB section backs. */
  readonly hasSection: boolean;
  readonly subgroups: readonly WorkstreamNode<T>[];
  /** Every section in the subtree, in the input order. */
  readonly sectionIds: readonly string[];
};

/** Id of a header drawn for a shared topic that has no section. */
export const sharedTopicId = (topicId: string) => `topic:${topicId}`;

const labelOf = (group: { name: string; label?: string }) =>
  group.label ?? group.name;

export function sortGroups<G extends Group<WorkstreamThread>>(
  groups: readonly G[],
  sort: GroupSort,
): G[] {
  if (sort === "manual") return [...groups];
  return [...groups].sort(
    (a, b) =>
      (sort === "activity"
        ? b.lastActiveAt - a.lastActiveAt
        : labelOf(a).localeCompare(labelOf(b))) ||
      labelOf(a).localeCompare(labelOf(b)),
  );
}

function sortTree<T extends WorkstreamThread>(
  nodes: readonly WorkstreamNode<T>[],
  sort: GroupSort,
): WorkstreamNode<T>[] {
  return sortGroups(nodes, sort).map((node) =>
    node.subgroups.length > 0
      ? { ...node, subgroups: sortTree(node.subgroups, sort) }
      : node,
  );
}

const leaf = <T extends WorkstreamThread>(
  group: Group<T>,
  topicId: string | null,
): WorkstreamNode<T> => ({
  ...group,
  topicId,
  label: group.name,
  hasSection: true,
  subgroups: [],
  sectionIds: [group.id],
});

/**
 * Nests workstreams by topic, keeping the input order: top-level groups by
 * their first workstream, subgroups likewise within their parent. Without
 * topics, or for a section whose topic is unknown, each workstream stands
 * alone.
 */
export function nestGroups<T extends WorkstreamThread>(
  groups: readonly Group<T>[],
  topics?: WorkstreamTopics,
): WorkstreamNode<T>[] {
  if (!topics) return groups.map((group) => leaf(group, null));
  const byId = new Map(topics.entities.map((entity) => [entity.id, entity]));
  /** Root-first topic path, or null for an unknown topic or a cycle. */
  const pathOf = (topicId: string): string[] | null => {
    const path: string[] = [];
    let current: string | null = topicId;
    while (current) {
      if (path.includes(current)) return null;
      const entity = byId.get(current);
      if (!entity) return null;
      path.unshift(current);
      current = entity.parentId;
    }
    return path;
  };
  const nameOf = (topicId: string) => byId.get(topicId)!.name;

  type Member = { group: Group<T>; path: string[]; index: number };
  type Slot = { standalone: WorkstreamNode<T> } | { cluster: Member[] };
  const slots: Slot[] = [];
  const clusters = new Map<string, Member[]>();
  groups.forEach((group, index) => {
    const topicId = topics.bindings[group.id];
    const path = topicId ? pathOf(topicId) : null;
    if (!path) {
      slots.push({ standalone: leaf(group, null) });
      return;
    }
    const cluster = clusters.get(path[0]!);
    if (cluster) cluster.push({ group, path, index });
    else {
      const members = [{ group, path, index }];
      clusters.set(path[0]!, members);
      slots.push({ cluster: members });
    }
  });

  const build = (members: Member[]): WorkstreamNode<T> => {
    if (members.length === 1)
      return leaf(members[0]!.group, members[0]!.path.at(-1)!);
    // The topics that head a node: each workstream's own, and every topic
    // two of them share most specifically. Pairwise sharing is enough; in a
    // tree, the topic three workstreams share is one two of them share.
    const pathOfNode = new Map<string, string[]>();
    for (const member of members)
      pathOfNode.set(member.path.at(-1)!, member.path);
    for (const [i, a] of members.entries())
      for (const b of members.slice(i + 1)) {
        let depth = 0;
        while (
          depth < a.path.length &&
          depth < b.path.length &&
          a.path[depth] === b.path[depth]
        )
          depth++;
        const shared = a.path.slice(0, depth);
        pathOfNode.set(shared.at(-1)!, shared);
      }
    /** The node a topic nests under: its nearest ancestor that heads one. */
    const parentOf = (topicId: string) =>
      pathOfNode
        .get(topicId)!
        .slice(0, -1)
        .reverse()
        .find((ancestor) => pathOfNode.has(ancestor)) ?? null;
    const firstIndex = new Map<string, number>();
    for (const member of members)
      for (const topicId of member.path)
        if (pathOfNode.has(topicId) && !firstIndex.has(topicId))
          firstIndex.set(topicId, member.index);

    const node = (
      topicId: string,
      parent: string | null,
    ): WorkstreamNode<T> => {
      const path = pathOfNode.get(topicId)!;
      const label = path
        .slice(parent ? path.indexOf(parent) + 1 : 0)
        .map(nameOf)
        .join(": ");
      const own = members.filter((member) => member.path.at(-1) === topicId);
      const children = [...pathOfNode.keys()]
        .filter((child) => parentOf(child) === topicId)
        .sort((a, b) => firstIndex.get(a)! - firstIndex.get(b)!)
        .map((child) => node(child, topicId));
      // A second section bound to the same topic nests as its sibling, not
      // its replacement, so none of its threads disappear.
      const [first, ...extra] = own;
      const subgroups = [
        ...extra.map((member) => ({
          ...leaf(member.group, topicId),
          label,
        })),
        ...children,
      ];
      const ownGroup = first?.group;
      const sectionIds = members
        .filter((member) => member.path.includes(topicId))
        .map((member) => member.group.id);
      return {
        id: ownGroup?.id ?? sharedTopicId(topicId),
        name: ownGroup?.name ?? path.map(nameOf).join(": "),
        rows: ownGroup?.rows ?? [],
        total:
          (ownGroup?.total ?? 0) +
          subgroups.reduce((sum, sub) => sum + sub.total, 0),
        needsYou:
          (ownGroup?.needsYou ?? 0) +
          subgroups.reduce((sum, sub) => sum + sub.needsYou, 0),
        lastActiveAt: Math.max(
          ownGroup?.lastActiveAt ?? 0,
          ...subgroups.map((sub) => sub.lastActiveAt),
        ),
        prioritized:
          (ownGroup?.prioritized ?? false) ||
          subgroups.some((sub) => sub.prioritized),
        topicId,
        label: parent ? label : (ownGroup?.name ?? label),
        hasSection: ownGroup !== undefined,
        subgroups,
        sectionIds,
      };
    };
    const top = [...pathOfNode.keys()].find((topicId) => !parentOf(topicId))!;
    return node(top, null);
  };

  return slots.map((slot) =>
    "standalone" in slot ? slot.standalone : build(slot.cluster),
  );
}

export type GroupArrangement<T extends WorkstreamThread> = {
  /** Focused workstreams, which pin below Up Next. */
  readonly pinned: readonly WorkstreamNode<T>[];
  /** Every other active workstream: populated ones, then empty ones. */
  readonly other: readonly WorkstreamNode<T>[];
  readonly populated: readonly WorkstreamNode<T>[];
  readonly empty: readonly WorkstreamNode<T>[];
  /** Workstreams with no recent activity, in the projection's order. */
  readonly dormant: readonly WorkstreamNode<T>[];
  /** The virtual group of threads in no workstream. */
  readonly unfiled: Group<T>;
  /** Some workstream is focused, so the rest hide behind a toggle. */
  readonly tiered: boolean;
  /** There is anything below the focused groups to reveal. */
  readonly hasLower: boolean;
};

/**
 * The sections whose threads count as focused (see `selectUpNext`): every
 * section in a top-level group that holds a focused one, so focusing a group
 * covers its subgroups.
 */
export function focusedSections<T extends WorkstreamThread>(
  arrangement: GroupArrangement<T>,
  prioritized: ReadonlySet<string>,
): Set<string> {
  return new Set(
    [...arrangement.pinned, ...arrangement.other, ...arrangement.dormant]
      .filter((node) => node.sectionIds.some((id) => prioritized.has(id)))
      .flatMap((node) => node.sectionIds),
  );
}

export function arrangeGroups<T extends WorkstreamThread>(
  projection: Projection<T>,
  sort: GroupSort,
  topics?: WorkstreamTopics,
): GroupArrangement<T> {
  // The projection decides dormancy per section from the clock; a nested
  // group is dormant only when nothing in it is still active.
  const active = new Set(
    projection.groups.filter((group) => group.total > 0).map((g) => g.id),
  );
  const nodes = nestGroups(projection.all, topics);
  const pinnedNodes: WorkstreamNode<T>[] = [];
  const otherNodes: WorkstreamNode<T>[] = [];
  const dormant: WorkstreamNode<T>[] = [];
  for (const node of nodes) {
    if (node.prioritized) pinnedNodes.push(node);
    else if (
      node.total > 0 &&
      !node.sectionIds.some((sectionId) => active.has(sectionId))
    )
      dormant.push(node);
    else otherNodes.push(node);
  }
  const pinned = sortTree(pinnedNodes, sort);
  const other = sortTree(otherNodes, sort);
  return {
    pinned,
    other,
    populated: other.filter((group) => group.total > 0),
    empty: other.filter((group) => group.total === 0),
    dormant: sortTree(dormant, "manual"),
    unfiled: projection.unsorted,
    tiered: pinned.length > 0,
    hasLower:
      other.length > 0 || projection.unsorted.total > 0 || dormant.length > 0,
  };
}
