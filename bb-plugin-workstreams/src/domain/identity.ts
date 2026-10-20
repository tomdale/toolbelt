import { z } from "zod";

/** Durable intent is independent of the title's presentation limit. */
export const objectiveSchema = z.object({
  summary: z.string().trim().min(1).max(1200),
  title: z.string().trim().min(1).max(60),
  evidenceIds: z.array(z.string().min(1).max(100)).min(1).max(12),
});
export type ThreadObjective = z.infer<typeof objectiveSchema>;
export const identityCandidateSchema = objectiveSchema.extend({
  change: z.enum(["keep", "refine", "pivot"]),
});
export type IdentityCandidate = z.infer<typeof identityCandidateSchema>;
export const IDENTITY_VERSION = 1;

/** A keep never rewrites identity; pivots must cite the latest user request. */
export function settleIdentity(args: {
  previous: ThreadObjective | null;
  candidate: IdentityCandidate | null;
  requestIds: readonly string[];
}): { objective: ThreadObjective | null; decision: string } {
  const { previous, candidate, requestIds } = args;
  if (!candidate)
    return {
      objective: previous,
      decision: "kept: no valid identity candidate",
    };
  if (candidate.change === "keep" && previous)
    return { objective: previous, decision: "kept: same overall objective" };
  const known = new Set([...requestIds, ...(previous?.evidenceIds ?? [])]);
  if (candidate.evidenceIds.some((id) => !known.has(id)))
    return {
      objective: previous,
      decision: "kept: unsupported identity evidence",
    };
  if (
    candidate.change === "refine" &&
    previous &&
    candidate.evidenceIds.every((id) => previous.evidenceIds.includes(id))
  )
    return {
      objective: previous,
      decision: "kept: refinement lacks new user evidence",
    };
  if (
    candidate.change === "pivot" &&
    !candidate.evidenceIds.includes(requestIds.at(-1) ?? "")
  )
    return {
      objective: previous,
      decision: "kept: pivot lacks latest user evidence",
    };
  return {
    objective: {
      summary: candidate.summary,
      title: candidate.title,
      evidenceIds: candidate.evidenceIds,
    },
    decision: previous ? candidate.change : "established",
  };
}
