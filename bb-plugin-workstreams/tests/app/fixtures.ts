import type {
  PluginSidebarSection,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

export function sidebarThread(
  id: string,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  const now = Date.now();
  return {
    id,
    projectId: "proj_1",
    title: `Title ${id}`,
    titleFallback: null,
    displayTitle: overrides.title ?? `Title ${id}`,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "pi",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: `/projects/proj_1/threads/${id}`,
    isHidden: false,
    environment: null,
    host: null,
    createdAt: now,
    updatedAt: now,
    lastReadAt: null,
    latestAttentionAt: now,
    ...overrides,
  } as PluginSidebarThread;
}

export function section(id: string, name: string): PluginSidebarSection {
  return { id, name, createdAt: 1, updatedAt: 1 } as PluginSidebarSection;
}

export const emptyState = () => ({
  workstreams: {},
  placements: {},
  analysis: {},
  proposals: [],
  bootstrapped: true,
  lastReconciledAt: null,
});
