import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildForest } from "../domain/tree.ts";
import type { Recap } from "../domain/recap.ts";
import { isDone, workView } from "../domain/status.ts";
import type { Analyzer } from "./analyzer.ts";
import type { CleanupMember } from "./cleanup.ts";
import { getMeta, setMeta, type Database } from "./db.ts";
import type { TopicStore } from "./topics.ts";
import {
  activeHome,
  ancestors,
  deriveActiveEntityIds,
} from "../domain/regroup.ts";
import { topicPath } from "../domain/topic-path.ts";
import type { TopicAssignment, Topic } from "../domain/topics.ts";
import { listSections, type InventoryThread } from "./inventory.ts";
import type { WorkstreamService } from "./service.ts";
import type { Journal, NewEntry } from "./journal.ts";
import type {
  OrganizerState,
  OrganizerStateCounts,
  OrganizerStateGroup,
  OrganizerStateGroupMember,
  OrganizerStateUnresolved,
} from "./contract.ts";

export type OrganizerDeps = {
  db: Database;
  service: WorkstreamService;
  topics: TopicStore;
  analyzer: Analyzer;
  /** Agent recaps for each thread's latest turn; they outrank analysis. */
  recaps?: () => Record<string, Recap>;
  members: (sectionId: string) => Promise<CleanupMember[]>;
  /** Records each pass's section changes in Activity. */
  journal?: Journal;
  policy?: () => { capacity: number; collapseAt: number };
  onChange: () => void;
  now?: () => number;
};

const KEY = "live_organization";

const DEFAULT_COUNTS: OrganizerStateCounts = {
  activeRoots: 0,
  completedRoots: 0,
  totalRoots: 0,
  unresolvedRoots: 0,
  activeWorkstreams: 0,
};

const DEFAULT_STATE: OrganizerState = {
  status: "idle",
  progress: null,
  error: null,
  lastUpdatedAt: null,
  groups: [],
  unresolved: [],
  counts: DEFAULT_COUNTS,
};

export class Organizer {
  private running = false;
  private rerunQueued = false;
  private disposed = false;
  private controller: AbortController | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSyncedHash: string | null = null;
  private forceNextRun = false;
  private activeRun: Promise<OrganizerState> | null = null;

  constructor(private readonly deps: OrganizerDeps) {
    const current = this.state();
    if (
      current &&
      (current.status === "classifying" ||
        current.status === "deriving" ||
        current.status === "syncing")
    ) {
      this.save({
        ...current,
        status: "idle",
      });
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  state(): OrganizerState {
    const raw = getMeta(this.deps.db, KEY);
    if (!raw) return DEFAULT_STATE;
    try {
      return JSON.parse(raw) as OrganizerState;
    } catch {
      return DEFAULT_STATE;
    }
  }

  private save(state: OrganizerState): OrganizerState {
    setMeta(this.deps.db, KEY, JSON.stringify(state));
    this.deps.onChange();
    return state;
  }

  isDone(): boolean {
    return getMeta(this.deps.db, "bootstrapped") === "1";
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.controller?.abort();
  }

  trigger(debounceMs = 50): void {
    if (this.disposed) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.run().catch(() => {});
    }, debounceMs);
  }

  async rebuild(): Promise<OrganizerState> {
    this.lastSyncedHash = null;
    this.forceNextRun = true;
    if (this.running) {
      this.rerunQueued = true;
      await this.activeRun?.catch(() => {});
      return this.run();
    }
    return this.run();
  }

  async run(): Promise<OrganizerState> {
    if (this.disposed) return this.state();

    if (this.running) {
      this.rerunQueued = true;
      return this.activeRun ?? Promise.resolve(this.state());
    }

    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    const isForced = this.forceNextRun;
    this.forceNextRun = false;

    const runPromise = (async () => {
      try {
        const result = await this.executePass(controller.signal, isForced);
        return result;
      } finally {
        this.running = false;
        this.controller = null;
        if (this.rerunQueued && !this.disposed) {
          this.rerunQueued = false;
          // Queue next pass asynchronously
          setTimeout(() => {
            void this.run().catch(() => {});
          }, 0);
        }
      }
    })();

    this.activeRun = runPromise;
    return runPromise;
  }

  private async executePass(
    signal: AbortSignal,
    isForced = false,
  ): Promise<OrganizerState> {
    const currentState = this.state();
    const sdk = (
      this.deps.service as unknown as { sdk: () => BbPluginApi["sdk"] }
    ).sdk();

    let passContext: {
      roots: InventoryThread[];
      isCompletedMap: Map<string, boolean>;
      assignments: Record<string, TopicAssignment>;
      selectedEntityIds: string[];
      entityToSection: Map<string, string>;
      appliedSectionIds: Map<string, string | null>;
      evidenceById: Map<string, string>;
      entities: Topic[];
    } | null = null;

    try {
      await this.deps.service.reconcile();
      const allThreads = this.deps.service.threads();
      const forest = buildForest(allThreads);

      // Only independently actionable visible, non-archived roots
      const roots = forest.roots
        .map((r) => r.thread)
        .filter((t) => !t.isHidden && !t.isArchived);

      const analysis = this.deps.analyzer.all();
      const recaps = this.deps.recaps?.() ?? {};
      const isCompletedMap = new Map<string, boolean>();
      for (const root of roots)
        isCompletedMap.set(
          root.id,
          isDone(workView(root, analysis[root.id], recaps[root.id])),
        );

      // Check if snapshot is identical to last completed run
      const catalogRev = this.deps.topics.revision();
      const snapshotHash = createHash("sha256")
        .update(
          JSON.stringify({
            catalogRev,
            roots: roots.map((r) => [
              r.id,
              r.title,
              r.sectionId,
              isCompletedMap.get(r.id),
              this.deps.topics.assignment(r.id).entityId,
              this.deps.topics.assignment(r.id).status,
              this.deps.topics.assignment(r.id).provenance,
            ]),
          }),
        )
        .digest("hex");

      if (
        !isForced &&
        this.lastSyncedHash === snapshotHash &&
        currentState.status === "idle"
      ) {
        return currentState;
      }

      // What each root's topic was settled from, shown for roots with none.
      const evidenceById = new Map<string, string>();
      for (const root of roots) {
        const basis = this.deps.topics.basis(root.id);
        if (basis) evidenceById.set(root.id, basis);
      }

      // 2. Derivation stage
      const entities = this.deps.topics.list();
      const assignments = this.deps.topics.assignments();

      const counts: Record<string, number> = {};
      const visibleProductRoots = new Set<string>();

      for (const root of roots) {
        const assignment = assignments[root.id];
        const isCompleted = isCompletedMap.get(root.id) ?? false;
        if (
          assignment &&
          assignment.status === "assigned" &&
          assignment.entityId
        ) {
          const rootAncestor = assignment.ancestorIds.at(-1);
          if (rootAncestor) {
            visibleProductRoots.add(rootAncestor);
          }
          if (!isCompleted) {
            counts[assignment.entityId] =
              (counts[assignment.entityId] ?? 0) + 1;
          }
        }
      }

      const currentActive = entities
        .filter((e) => {
          const groups = this.deps.topics.groups();
          return Array.from(groups.values()).includes(e.id);
        })
        .map((e) => e.id);

      const policy = this.deps.policy?.() ?? { capacity: 6, collapseAt: 3 };
      const rawSelectedEntityIds = deriveActiveEntityIds({
        entities,
        counts,
        active: currentActive,
        capacity: policy.capacity,
        collapseAt: policy.collapseAt,
        visibleProductRoots: Array.from(visibleProductRoots),
      });

      // Filter to only groups that receive tasks (active or completed retention)
      const groupLoads = new Map<string, number>();
      for (const root of roots) {
        const assignment = assignments[root.id];
        if (
          assignment &&
          assignment.status === "assigned" &&
          assignment.entityId
        ) {
          const home = activeHome(
            assignment.entityId,
            rawSelectedEntityIds,
            entities,
          );
          if (home) {
            groupLoads.set(home, (groupLoads.get(home) ?? 0) + 1);
          }
        }
      }
      const selectedEntityIds = rawSelectedEntityIds.filter(
        (id) => (groupLoads.get(id) ?? 0) > 0,
      );

      // 3. Sync Native Section Projection
      const entityToSection = new Map<string, string>();
      const appliedSectionIds = new Map<string, string | null>();

      passContext = {
        roots,
        isCompletedMap,
        assignments,
        selectedEntityIds,
        entityToSection,
        appliedSectionIds,
        evidenceById,
        entities,
      };

      // Section changes run in the service's mutation queue, so a move,
      // retitle, or reconcile never interleaves with them, and whatever
      // changed is recorded in Activity even when the pass fails partway.
      const changes = new SyncChanges();
      await this.deps.service.exclusive(async () => {
        let failed = false;
        try {
          const liveSections = await listSections(sdk);
          for (const section of liveSections)
            changes.name(section.id, section.name);
          const groupBindings = new Map(this.deps.topics.groups()); // sectionId -> entityId

          for (const entityId of selectedEntityIds) {
            const entity = entities.find((e) => e.id === entityId)!;
            const expectedName = topicPath(entityId, entities);

            // Check if an existing section is already bound to this entityId
            let section = liveSections.find(
              (s) => groupBindings.get(s.id) === entityId,
            );

            if (!section) {
              // Check if an existing section matches the name and is not bound to another active entity
              const candidate = liveSections.find(
                (s) =>
                  s.name.toLowerCase() === expectedName.toLowerCase() &&
                  (!groupBindings.has(s.id) ||
                    groupBindings.get(s.id) === entityId ||
                    !selectedEntityIds.includes(groupBindings.get(s.id)!)),
              );
              if (candidate) {
                section = candidate;
                this.deps.topics.bindGroup(section.id, entityId);
                groupBindings.set(section.id, entityId); // Update local map (Finding 4)
              }
            }

            if (!section) {
              // Create a new native section owned by workstreams (Finding 7)
              const created = await sdk.threadSections.create({
                name: expectedName,
              });
              section = { id: created.id, name: created.name };
              changes.created.push(created.id);
              changes.name(created.id, created.name);
              const now = this.now();
              this.deps.db
                .prepare(
                  `INSERT INTO ws_workstream (section_id, description, description_source, created_by, created_at, updated_at)
               VALUES (?, NULL, 'generated', 'workstreams', ?, ?)
               ON CONFLICT(section_id) DO UPDATE SET created_by = 'workstreams'`,
                )
                .run(created.id, now, now);
              this.deps.topics.bindGroup(created.id, entityId);
              groupBindings.set(created.id, entityId); // Update local map (Finding 4)
              this.deps.service.seeSection(created.id, created.name);
            } else if (section.name !== expectedName) {
              // Rename section if entity name changed
              await sdk.threadSections.update({
                id: section.id,
                name: expectedName,
              });
              changes.renamed.push({
                id: section.id,
                from: section.name,
                to: expectedName,
              });
              changes.name(section.id, expectedName);
              section = { id: section.id, name: expectedName };
              this.deps.service.seeSection(section.id, expectedName);
            }

            entityToSection.set(entityId, section.id);
          }

          // Update roots' sectionId in BB
          for (const root of roots) {
            const assignment = assignments[root.id];
            let targetSectionId: string | null = null;

            if (
              assignment &&
              assignment.status === "assigned" &&
              assignment.entityId
            ) {
              const homeEntityId = activeHome(
                assignment.entityId,
                selectedEntityIds,
                entities,
              );
              if (homeEntityId) {
                targetSectionId = entityToSection.get(homeEntityId) ?? null;
              }
            }

            if ((root.sectionId ?? null) !== targetSectionId) {
              // The snapshot is from the start of the pass; classification may
              // have taken a while, so write only what still differs.
              const live = await sdk.threads
                .get({ threadId: root.id })
                .catch(() => null);
              const from = live?.sectionId ?? null;
              if (
                live &&
                live.archivedAt === null &&
                live.visibility !== "hidden" &&
                from !== targetSectionId
              ) {
                await sdk.threads.update({
                  threadId: root.id,
                  sectionId: targetSectionId,
                });
                changes.moves.push({
                  threadId: root.id,
                  title: root.title,
                  from,
                  to: targetSectionId,
                });
                this.deps.service.seeThread(
                  root.id,
                  targetSectionId,
                  root.parentThreadId ?? null,
                  root.title,
                );
              }
            }
            appliedSectionIds.set(root.id, targetSectionId);
          }

          // Clean up unused empty sections that belonged to Workstreams
          const activeSectionIds = new Set(entityToSection.values());

          for (const section of liveSections) {
            // Never delete an active section (Finding 4)
            if (activeSectionIds.has(section.id)) continue;

            const boundEntityId = groupBindings.get(section.id);
            if (boundEntityId && !selectedEntityIds.includes(boundEntityId)) {
              const members = await this.deps.members(section.id);
              const activeMembers = members.filter(
                (m) => m.archivedAt === null,
              );
              if (activeMembers.length === 0) {
                // Check ownership safety policy (Finding 7)
                const wsRow = this.deps.db
                  .prepare(
                    "SELECT created_by FROM ws_workstream WHERE section_id = ?",
                  )
                  .get(section.id) as { created_by: string } | undefined;

                if (wsRow?.created_by === "workstreams") {
                  await sdk.threadSections.delete({ id: section.id });
                  changes.removed.push(section.id);
                  this.deps.db
                    .prepare("DELETE FROM ws_seen_section WHERE section_id = ?")
                    .run(section.id);
                  this.deps.db
                    .prepare("DELETE FROM ws_workstream WHERE section_id = ?")
                    .run(section.id);
                }
                this.deps.topics.unbindGroup(section.id);
                groupBindings.delete(section.id);
              }
            }
          }
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          this.record(changes, failed);
        }
      });

      // Topics Workstreams discovered that nothing uses any more go away.
      const pruned = this.deps.topics.prune();
      if (pruned.length)
        this.deps.journal?.add({
          action: "remove-topic",
          source: "auto",
          rationale:
            pruned.length === 1
              ? `Removed the unused topic ${pruned[0]!.name}`
              : `Removed ${pruned.length} unused topics`,
          threads: [],
          workstreams: [],
          undo: null,
          detail: pruned.map((topic) => `Removed ${topic.name}`).join("\n"),
        });

      // 4. Assemble OrganizerState
      const finalState = this.assembleOrganizerState({
        status: "idle",
        error: null,
        roots,
        isCompletedMap,
        assignments,
        selectedEntityIds,
        entityToSection,
        appliedSectionIds,
        evidenceById,
        entities,
      });

      setMeta(this.deps.db, "bootstrapped", "1");

      // Post-sync fingerprint using appliedSectionIds (Finding 6)
      const postSyncSnapshotHash = createHash("sha256")
        .update(
          JSON.stringify({
            catalogRev: this.deps.topics.revision(),
            roots: roots.map((r) => [
              r.id,
              r.title,
              appliedSectionIds.get(r.id) ?? r.sectionId,
              isCompletedMap.get(r.id),
              this.deps.topics.assignment(r.id).entityId,
              this.deps.topics.assignment(r.id).status,
              this.deps.topics.assignment(r.id).provenance,
            ]),
          }),
        )
        .digest("hex");
      this.lastSyncedHash = postSyncSnapshotHash;

      return this.save(finalState);
    } catch (err) {
      if (signal.aborted || this.disposed) return this.state();
      const errMsg = err instanceof Error ? err.message : String(err);

      // Finding 9: Partial mutation state truth
      if (passContext && passContext.selectedEntityIds.length > 0) {
        const failedState = this.assembleOrganizerState({
          status: "failed",
          error: errMsg,
          roots: passContext.roots,
          isCompletedMap: passContext.isCompletedMap,
          assignments: passContext.assignments,
          selectedEntityIds: passContext.selectedEntityIds,
          entityToSection: passContext.entityToSection,
          appliedSectionIds: passContext.appliedSectionIds,
          evidenceById: passContext.evidenceById,
          entities: passContext.entities,
        });
        return this.save(failedState);
      }

      return this.save({
        ...currentState,
        status: "failed",
        error: errMsg,
        progress: null,
      });
    }
  }

  /**
   * Records one pass's section changes as one Activity entry. It has no undo:
   * workstreams follow topics, so the next pass would redo whatever an undo
   * reverted. Changing a thread's topic is how to move it.
   */
  private record(changes: SyncChanges, failed: boolean): void {
    const entry = changes.entry(failed);
    if (entry) this.deps.journal?.add(entry);
  }

  private assembleOrganizerState(options: {
    status: OrganizerState["status"];
    error: string | null;
    roots: InventoryThread[];
    isCompletedMap: Map<string, boolean>;
    assignments: Record<string, TopicAssignment>;
    selectedEntityIds: string[];
    entityToSection: Map<string, string>;
    appliedSectionIds: Map<string, string | null>;
    evidenceById: Map<string, string>;
    entities: Topic[];
  }): OrganizerState {
    const {
      status,
      error,
      roots,
      isCompletedMap,
      assignments,
      selectedEntityIds,
      entityToSection,
      appliedSectionIds,
      evidenceById,
      entities,
    } = options;

    const groupsMap = new Map<string, OrganizerStateGroup>();
    for (const entityId of selectedEntityIds) {
      const entity = entities.find((e) => e.id === entityId);
      const name = entity ? topicPath(entityId, entities) : entityId;
      groupsMap.set(entityId, {
        key: entityId,
        sectionId: entityToSection.get(entityId) ?? null,
        name,
        description: entity?.description || name,
        activeCount: 0,
        completedCount: 0,
        totalCount: 0,
        roots: [],
      });
    }

    const unresolvedTasks: OrganizerStateUnresolved[] = [];
    let activeRootsCount = 0;
    let completedRootsCount = 0;

    for (const root of roots) {
      const assignment = assignments[root.id];
      const isCompleted = isCompletedMap.get(root.id) ?? false;
      if (isCompleted) {
        completedRootsCount++;
      } else {
        activeRootsCount++;
      }

      if (
        !assignment ||
        assignment.status === "unresolved" ||
        !assignment.entityId
      ) {
        unresolvedTasks.push({
          id: root.id,
          title: root.title,
          completed: isCompleted,
          evidence: evidenceById.get(root.id) ?? null,
          reason: isCompleted
            ? "Done; no topic."
            : "No topic yet, so it stays Unfiled.",
        });
        continue;
      }

      const homeEntityId = activeHome(
        assignment.entityId,
        selectedEntityIds,
        entities,
      );
      const group = homeEntityId ? groupsMap.get(homeEntityId) : null;

      if (group) {
        if (isCompleted) {
          group.completedCount++;
        } else {
          group.activeCount++;
        }
        group.totalCount++;

        const entity = entities.find((e) => e.id === assignment.entityId);
        const topicLabel = entity ? topicPath(entity.id, entities) : null;

        let reason: string;
        if (isCompleted) {
          reason = `Done; kept in ${group.name}.`;
        } else if (assignment.provenance === "manual") {
          reason = `You set its topic to ${topicLabel}; filed in ${group.name}.`;
        } else if (topicLabel && topicLabel !== group.name) {
          reason = `Its topic is ${topicLabel}; filed in ${group.name}.`;
        } else {
          reason = `Its topic is ${group.name}.`;
        }

        group.roots.push({
          id: root.id,
          title: root.title,
          completed: isCompleted,
          topicId: assignment.entityId,
          topicLabel,
          provenance: assignment.provenance,
          reason,
        });
      } else {
        unresolvedTasks.push({
          id: root.id,
          title: root.title,
          completed: isCompleted,
          evidence: evidenceById.get(root.id) ?? null,
          reason: "Its topic has no workstream, so it stays Unfiled.",
        });
      }
    }

    const finalGroups = Array.from(groupsMap.values()).filter(
      (g) => g.totalCount > 0,
    );

    return {
      status,
      progress: null,
      error,
      lastUpdatedAt: this.now(),
      groups: finalGroups,
      unresolved: unresolvedTasks,
      counts: {
        activeRoots: activeRootsCount,
        completedRoots: completedRootsCount,
        totalRoots: roots.length,
        unresolvedRoots: unresolvedTasks.length,
        activeWorkstreams: finalGroups.length,
      },
    };
  }
}

/** What one organizer pass changed in BB, for its Activity entry. */
class SyncChanges {
  readonly created: string[] = [];
  readonly renamed: { id: string; from: string; to: string }[] = [];
  readonly moves: {
    threadId: string;
    title: string;
    from: string | null;
    to: string | null;
  }[] = [];
  readonly removed: string[] = [];
  private readonly names = new Map<string, string>();

  /** Remembers a section's name as of this pass. */
  name(sectionId: string, name: string): void {
    this.names.set(sectionId, name);
  }

  private nameOf(sectionId: string | null): string {
    return sectionId === null
      ? "Unfiled"
      : (this.names.get(sectionId) ?? "a deleted workstream");
  }

  entry(failed: boolean): NewEntry | null {
    const { created, renamed, moves, removed } = this;
    if (!created.length && !renamed.length && !moves.length && !removed.length)
      return null;
    const count = (n: number, one: string, many: string) =>
      n === 0 ? null : `${n} ${n === 1 ? one : many}`;
    const summary = [
      count(moves.length, "thread moved", "threads moved"),
      count(created.length, "workstream created", "workstreams created"),
      count(renamed.length, "workstream renamed", "workstreams renamed"),
      count(
        removed.length,
        "empty workstream removed",
        "empty workstreams removed",
      ),
    ].filter((part): part is string => part !== null);
    const detail = [
      ...created.map((id) => `Created ${this.nameOf(id)}`),
      ...renamed.map((r) => `Renamed ${r.from} to ${r.to}`),
      ...moves.map(
        (m) =>
          `Moved “${m.title}” from ${this.nameOf(m.from)} to ${this.nameOf(m.to)}`,
      ),
      ...removed.map(
        (id) => `Removed ${this.nameOf(id)}, which had no threads`,
      ),
      "Workstreams follow topics; change a thread’s topic to move it.",
      ...(failed
        ? ["The pass stopped partway; the next one finishes it."]
        : []),
    ].join("\n");
    const touched = new Set<string>([
      ...created,
      ...renamed.map((r) => r.id),
      ...removed,
      ...moves.flatMap((m) => [m.from, m.to].filter((id) => id !== null)),
    ]);
    return {
      action: "batch",
      source: "auto",
      status: failed ? "failed" : "applied",
      rationale: `Organized by topic: ${summary.join(", ")}`,
      threads: moves.map((m) => ({ id: m.threadId, name: m.title })),
      workstreams: [...touched].map((id) => ({ id, name: this.nameOf(id) })),
      undo: null,
      detail,
    };
  }
}
