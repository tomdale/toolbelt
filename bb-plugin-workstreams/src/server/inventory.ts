/**
 * Reads BB's live inventory for server-side work (reconciler, CLI). The app
 * reads the same facts through the sidebar hook; both feed the domain
 * projection, so their shapes are normalized here.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Section, WorkstreamThread } from "../domain/project.ts";

type Sdk = BbPluginApi["sdk"];
type ThreadResponse = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];

export type InventoryThread = WorkstreamThread & {
  readonly title: string;
  readonly projectId: string;
  readonly status: string;
  /** Set on forks: the thread this one was forked from. */
  readonly sourceThreadId: string | null;
};

const PAGE = 100;

export function displayTitle(thread: {
  id: string;
  title: string | null;
  titleFallback?: string | null;
}): string {
  return (
    thread.title ?? thread.titleFallback ?? `Thread ${thread.id.slice(-6)}`
  );
}

export function toInventoryThread(thread: ThreadResponse): InventoryThread {
  return {
    id: thread.id,
    title: displayTitle(thread),
    projectId: thread.projectId,
    status: thread.status,
    sourceThreadId: thread.sourceThreadId ?? null,
    parentThreadId: thread.parentThreadId ?? null,
    sectionId: thread.sectionId ?? null,
    isHidden: thread.visibility === "hidden",
    isArchived: thread.archivedAt !== null,
    isPinned: thread.pinnedAt !== null,
    pinSortKey: null,
    hasPendingInteraction: Boolean(
      (thread as { hasPendingInteraction?: boolean }).hasPendingInteraction,
    ),
    latestAttentionAt: thread.latestAttentionAt ?? thread.updatedAt,
    createdAt: thread.createdAt,
  };
}

/** Every visible, non-archived thread, paged so nothing is cut off. */
export async function listActiveThreads(
  sdk: Sdk,
  signal?: AbortSignal,
): Promise<InventoryThread[]> {
  const out = new Map<string, InventoryThread>();
  for (let offset = 0; ; offset += PAGE) {
    const page = await sdk.threads.list({
      archived: false,
      includeHidden: false,
      limit: PAGE,
      offset,
      signal,
    });
    for (const thread of page) {
      if (thread.archivedAt !== null || thread.visibility === "hidden")
        continue;
      out.set(thread.id, toInventoryThread(thread));
    }
    if (page.length < PAGE) break;
  }
  return [...out.values()];
}

export async function listSections(sdk: Sdk): Promise<Section[]> {
  return (await sdk.threadSections.list()).map((section) => ({
    id: section.id,
    name: section.name,
  }));
}

/** True when no thread in any lifecycle or visibility is filed in the section. */
export async function sectionIsEmpty(
  sdk: Sdk,
  sectionId: string,
): Promise<boolean> {
  for (const archived of [false, true]) {
    const page = await sdk.threads.list({
      sectionId,
      archived,
      includeHidden: true,
      limit: 1,
    });
    if (page.length > 0) return false;
  }
  return true;
}
