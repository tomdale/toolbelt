import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const ARCHIVE_GRACE_MS = 24 * 60 * 60 * 1000;
export type CleanupMember = {
  id: string;
  archivedAt: number | null;
  sectionId: string | null;
};
export type CleanupCandidate = {
  sectionId: string;
  name: string;
  archivedThreads: { id: string; archivedAt: number }[];
  latestArchivedAt: number | null;
};

/** Read both lifecycles and hidden threads: sidebar visibility is not deletion eligibility. */
export async function sectionMembers(
  sdk: BbPluginApi["sdk"],
  sectionId: string,
): Promise<CleanupMember[]> {
  const members = new Map<string, CleanupMember>();
  for (const archived of [false, true]) {
    for (let offset = 0; ; offset += 100) {
      const page = await sdk.threads.list({
        sectionId,
        archived,
        includeHidden: true,
        limit: 100,
        offset,
      });
      for (const thread of page) {
        if (thread.sectionId === sectionId)
          members.set(thread.id, {
            id: thread.id,
            archivedAt: thread.archivedAt,
            sectionId,
          });
      }
      if (page.length < 100) break;
    }
  }
  return [...members.values()];
}

/** Planned moves may empty a home; at Apply the caller supplies the actual remaining membership. */
export function cleanupCandidate(
  section: { id: string; name: string },
  members: readonly CleanupMember[],
  now: number,
  movingAway: ReadonlySet<string> = new Set(),
): CleanupCandidate | null {
  const remaining = members.filter((t) => !movingAway.has(t.id));
  if (remaining.some((t) => t.archivedAt === null)) return null;
  const archivedThreads = remaining.map((t) => ({
    id: t.id,
    archivedAt: t.archivedAt!,
  }));
  const latestArchivedAt = archivedThreads.length
    ? Math.max(...archivedThreads.map((t) => t.archivedAt))
    : null;
  if (latestArchivedAt !== null && latestArchivedAt >= now - ARCHIVE_GRACE_MS)
    return null;
  return {
    sectionId: section.id,
    name: section.name,
    archivedThreads,
    latestArchivedAt,
  };
}
