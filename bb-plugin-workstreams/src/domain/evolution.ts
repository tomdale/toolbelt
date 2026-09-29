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
  /** Snoozed keys and the evidence count when they were dismissed. */
  readonly snoozed?: ReadonlyMap<string, number>;
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

  // Evidence: roots grouped by (workstream, subject). Recently user-moved
  // roots are excluded; the user's placement stands.
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
  for (const group of groups.values()) {
    const sourceSectionId = group[0]!.sectionId!;
    const source = own.get(sourceSectionId)!;
    const subject = mostCommon(group.map((r) => r.subject!));
    const subjectKey = normalize(subject);
    const active = group.filter((r) => r.active).map((r) => r.id);
    if (active.length === 0) continue;
    // A subject that names the thread's own workstream is home already.
    if (byName.get(subjectKey)?.id === sourceSectionId) continue;
    const target = byName.get(subjectKey);
    // Moving needs a live target: a workstream with at least one thread.
    if (target && (everFiled.get(target.id) ?? 0) > 0) {
      const everyone = members.get(sourceSectionId) ?? 0;
      const kind: ProposalKind = active.length === everyone ? "merge" : "move";
      candidates.push({
        key: proposalKey(kind, sourceSectionId, subject),
        kind,
        subject: target.name,
        sourceSectionId,
        targetSectionId: target.id,
        newName: null,
        threadIds: active,
        evidenceCount: group.length,
      });
      continue;
    }
    if (target) continue;
    // Spin out only a secondary subject: never the workstream's own core,
    // and never most of its active roots.
    if (group.length < SPIN_OUT_MIN[options.sensitivity]) continue;
    const total = members.get(sourceSectionId) ?? 0;
    if (!relaxed && active.length * 2 > total) continue;
    if (normalize(source.name).includes(subjectKey)) continue;
    candidates.push({
      key: proposalKey("spin-out", sourceSectionId, subject),
      kind: "spin-out",
      subject,
      sourceSectionId,
      targetSectionId: null,
      newName: subject,
      threadIds: active,
      evidenceCount: group.length,
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
    const snoozedAt = options.snoozed?.get(candidate.key);
    // A dismissed subject comes back only after two more roots.
    if (snoozedAt !== undefined && candidate.evidenceCount < snoozedAt + 2)
      continue;
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
