import type { TopicAssignment } from "../domain/topics.ts";

/** Facts whose changes invalidate an inference about a thread's current work. */
export function threadEvidence(thread: {
  projectId?: string;
  latestAttentionAt?: number | null;
  updatedAt: number;
  status?: string;
  parentThreadId?: string | null;
  archivedAt: number | null;
  visibility: string;
}): string {
  return JSON.stringify([
    thread.projectId ?? null,
    thread.latestAttentionAt ?? thread.updatedAt,
    thread.status,
    thread.parentThreadId ?? null,
    thread.archivedAt,
    thread.visibility,
  ]);
}

/** Includes provenance and basis so a correction to the same topic still wins. */
export function assignmentEvidence(assignment: TopicAssignment): string {
  return JSON.stringify([
    assignment.entityId,
    assignment.provenance,
    assignment.evidence,
    assignment.inheritedFrom,
  ]);
}
