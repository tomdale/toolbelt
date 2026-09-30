/**
 * Workstream evolution (SPEC §9): deterministic proposals from per-root
 * evidence. A model never decides whether a proposal exists; it may only name
 * or describe one that already crossed its threshold.
 *
 * Three kinds of change stay separate: one thread's drift is flagged on that
 * thread (§10), map evolution is proposed here, and classification noise is
 * suppressed because membership is never re-derived turn by turn.
 */

export type Sensitivity = "responsive" | "balanced" | "conservative";

/** Roots with one subject needed in one workstream before a spin-out. */
export const SPIN_OUT_MIN: Record<Sensitivity, number> = {
  responsive: 2,
  balanced: 3,
  conservative: 4,
};

export const EVIDENCE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
export const USER_MOVE_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_OPEN = 3;

export type EvolutionRoot = {
  readonly id: string;
  readonly sectionId: string | null;
  readonly subject: string | null;
  /** Independent evidence that this thread actually changed workstreams. */
  readonly drift?: {
    workstream: string | null;
    newName?: string | null;
    confidence: "high" | "medium" | "low";
  } | null;
  readonly active: boolean;
  readonly lastActiveAt: number;
  /** When the user (or someone outside Workstreams) last moved it. */
  readonly userMovedAt: number | null;
};

export type EvolutionWorkstream = {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
};

export type ProposalKind = "spin-out" | "move" | "merge";

export type Candidate = {
  /** Stable identity: the same evidence always yields the same key. */
  readonly key: string;
  readonly kind: ProposalKind;
  readonly subject: string;
  readonly sourceSectionId: string;
  /** Existing target for move and merge. */
  readonly targetSectionId: string | null;
  /** New workstream name for spin-out. */
  readonly newName: string | null;
  /** Active roots the proposal would move. */
  readonly threadIds: readonly string[];
  /** Roots behind the evidence, archived ones included. */
  readonly evidenceCount: number;
};

export type DetectOptions = {
  readonly now: number;
  readonly sensitivity: Sensitivity;
  /**
   * Snoozed subjects ({@link snoozeKey}) and their evidence count when
   * dismissed or undone. Kind-agnostic, so a dismissed move that grows into a
   * merge still waits for two more roots.
   */
  readonly snoozed?: ReadonlyMap<string, number>;
  /** Keys already raised; they neither return nor take a slot. */
  readonly exclude?: ReadonlySet<string>;
  /** Apply the per-workstream and global caps (default true). */
  readonly capped?: boolean;
  /** Source workstreams that already have an open proposal. */
  readonly openSources?: ReadonlySet<string>;
  /** Open proposals across all workstreams. */
  readonly openCount?: number;
  /** Bootstrap relaxes the window, activity, and caps. */
  readonly relaxed?: boolean;
};

export const normalize = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "");

export const proposalKey = (
  kind: ProposalKind,
  sourceSectionId: string,
  subject: string,
) => `${kind}:${sourceSectionId}:${normalize(subject)}`;

/** The snooze identity of a proposal key: its source and subject. */
export const snoozeKey = (key: string) => key.slice(key.indexOf(":") + 1);

/**
 * Proposals the evidence supports now, most evidence first, within the
 * anti-churn caps: at most one open proposal per source workstream and
 * {@link MAX_OPEN} overall.
 */
export function detectProposals(
  roots: readonly EvolutionRoot[],
  workstreams: readonly EvolutionWorkstream[],
  options: DetectOptions,
): Candidate[] {
  const relaxed = options.relaxed === true;
  const byName = new Map<string, EvolutionWorkstream>();
  for (const ws of workstreams)
    for (const name of [ws.name, ...ws.aliases])
      byName.set(normalize(name), ws);
  const own = new Map(workstreams.map((ws) => [ws.id, ws]));

  // Recently user-moved roots are excluded; the user's placement stands.
  const groups = new Map<string, EvolutionRoot[]>();
  const members = new Map<string, number>();
  const everFiled = new Map<string, number>();
  for (const root of roots) {
    if (!root.sectionId || !own.has(root.sectionId)) continue;
    everFiled.set(root.sectionId, (everFiled.get(root.sectionId) ?? 0) + 1);
    if (root.active)
      members.set(root.sectionId, (members.get(root.sectionId) ?? 0) + 1);
    if (!root.subject || !normalize(root.subject)) continue;
    if (!relaxed && options.now - root.lastActiveAt > EVIDENCE_WINDOW_MS)
      continue;
    if (
      root.userMovedAt !== null &&
      options.now - root.userMovedAt < USER_MOVE_COOLDOWN_MS
    )
      continue;
    const key = `${root.sectionId}\u0000${normalize(root.subject)}`;
    groups.set(key, [...(groups.get(key) ?? []), root]);
  }

  const candidates: Candidate[] = [];
  // Relocation is based on explicit drift, independent of the extracted
  // subject. Subject labels describe the product; they are not a decision to
  // leave the current workstream.
  const driftGroups = new Map<string, EvolutionRoot[]>();
  for (const root of roots) {
    if (!root.sectionId || !own.has(root.sectionId) || !root.active) continue;
    if (!relaxed && options.now - root.lastActiveAt > EVIDENCE_WINDOW_MS)
      continue;
    if (
      root.userMovedAt !== null &&
      options.now - root.userMovedAt < USER_MOVE_COOLDOWN_MS
    )
      continue;
    if (root.drift?.confidence !== "high") continue;
    if (!root.drift.workstream) continue;
    const target = byName.get(normalize(root.drift.workstream));
    if (!target || target.id === root.sectionId) continue;
    if ((everFiled.get(target.id) ?? 0) === 0) continue;
    const key = `${root.sectionId}\u0000${target.id}`;
    driftGroups.set(key, [...(driftGroups.get(key) ?? []), root]);
  }
  for (const moved of driftGroups.values()) {
    const sourceSectionId = moved[0]!.sectionId!;
    const target = byName.get(normalize(moved[0]!.drift!.workstream!))!;
    const everyone = members.get(sourceSectionId) ?? 0;
    const kind: ProposalKind = moved.length === everyone ? "merge" : "move";
    candidates.push({
      key: proposalKey(kind, sourceSectionId, target.name),
      kind,
      subject: target.name,
      sourceSectionId,
      targetSectionId: target.id,
      newName: null,
      threadIds: moved.map((root) => root.id),
      evidenceCount: moved.length,
    });
  }
  for (const group of groups.values()) {
    const sourceSectionId = group[0]!.sectionId!;
    const source = own.get(sourceSectionId)!;
    const subject = mostCommon(group.map((root) => root.subject!));
    const subjectKey = normalize(subject);
    const active = group.filter((root) => root.active).map((root) => root.id);
    if (!active.length) continue;
    if (byName.get(subjectKey)?.id === sourceSectionId) continue;
    // Existing workstreams are only move targets on explicit drift above.
    if (byName.has(subjectKey)) continue;
    // A repeated label can be a component of the current product or a broad
    // substrate. Spin-outs need independent high-confidence ownership evidence.
    const newProduct = group.filter(
      (root) =>
        root.drift?.confidence === "high" &&
        root.drift.newName != null &&
        normalize(root.drift.newName) === subjectKey,
    );
    if (newProduct.length < SPIN_OUT_MIN[options.sensitivity]) continue;
    const moving = newProduct
      .filter((root) => root.active)
      .map((root) => root.id);
    if (!moving.length) continue;
    const total = members.get(sourceSectionId) ?? 0;
    if (!relaxed && moving.length * 2 > total) continue;
    if (normalize(source.name).includes(subjectKey)) continue;
    candidates.push({
      key: proposalKey("spin-out", sourceSectionId, subject),
      kind: "spin-out",
      subject,
      sourceSectionId,
      targetSectionId: null,
      newName: subject,
      threadIds: moving,
      evidenceCount: newProduct.length,
    });
  }

  candidates.sort(
    (a, b) => b.evidenceCount - a.evidenceCount || a.key.localeCompare(b.key),
  );
  if (relaxed) return candidates;

  const out: Candidate[] = [];
  const sources = new Set(options.openSources ?? []);
  let open = options.openCount ?? 0;
  for (const candidate of candidates) {
    if (options.exclude?.has(candidate.key)) continue;
    const snoozedAt = options.snoozed?.get(snoozeKey(candidate.key));
    // A dismissed subject comes back only after two more roots.
    if (snoozedAt !== undefined && candidate.evidenceCount < snoozedAt + 2)
      continue;
    if (options.capped === false) {
      out.push(candidate);
      continue;
    }
    if (sources.has(candidate.sourceSectionId)) continue;
    if (open >= MAX_OPEN) break;
    out.push(candidate);
    sources.add(candidate.sourceSectionId);
    open++;
  }
  return out;
}

function mostCommon(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]![0];
}

/**
 * Banner copy (SPEC §9), kept exactly: the pending question and the applied
 * notice. `others` counts the other affected threads.
 */
export function pendingCopy(
  kind: ProposalKind,
  subject: string,
  others: number,
  sourceName: string,
): { text: string; accept: string } {
  const who =
    others === 0
      ? "This thread looks"
      : `This thread and ${others} other${others === 1 ? "" : "s"} look`;
  if (kind === "spin-out")
    return {
      text: `${who} like ${subject} work. Spin out a ${subject} workstream?`,
      accept: "Spin out",
    };
  if (kind === "merge")
    return {
      text: `${who} like ${subject} work. Merge ${sourceName} into ${subject}?`,
      accept: "Merge",
    };
  return {
    text: `${who} like ${subject} work. Move to ${subject}?`,
    accept: "Move",
  };
}

export const appliedCopy = (fromName: string, toName: string) =>
  `Moved from ${fromName} → ${toName}`;
