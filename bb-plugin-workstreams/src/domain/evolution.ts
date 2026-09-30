/** Shared proposal vocabulary and user-facing copy for workstream changes. */

export type Sensitivity = "responsive" | "balanced" | "conservative";
export type ProposalKind = "spin-out" | "move" | "merge";

export type Candidate = {
  readonly key: string;
  readonly kind: ProposalKind;
  readonly subject: string;
  readonly sourceSectionId: string;
  readonly targetSectionId: string | null;
  readonly newName: string | null;
  readonly threadIds: readonly string[];
  /** Stable signature of relevant evidence, stored in ws_proposal/ws_snooze. */
  readonly evidenceCount: number;
  readonly reason: string;
  readonly confidence: number;
  /** Root revisions and placements at proposal time, for deterministic validation. */
  readonly snapshot: Readonly<
    Record<string, { revision: number; sectionId: string | null }>
  >;
};

export const normalize = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "");

export const proposalKey = (
  kind: ProposalKind,
  sourceSectionId: string,
  targetIdentity: string,
) =>
  `${kind}:${sourceSectionId}:${kind === "spin-out" ? normalize(targetIdentity) : targetIdentity}`;

export const snoozeKey = (key: string) => key.slice(key.indexOf(":") + 1);

/** Banner copy and applied notice remain stable across supervision policy changes. */
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
