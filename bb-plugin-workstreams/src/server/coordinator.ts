import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildForest } from "../domain/tree.ts";
import { isCurrent } from "../domain/analysis.ts";
import type { ModelChoice } from "../domain/prefs.ts";
import type { Analyzer } from "./analyzer.ts";
import { sectionMembers, type CleanupMember } from "./cleanup.ts";
import { getMeta, setMeta, type Database } from "./db.ts";
import { classificationEvidence, type CorpusStore } from "./corpus.ts";
import {
  activeHome,
  ancestors,
  deriveActiveEntityIds,
} from "../domain/regroup.ts";
import { corpusLabel } from "../domain/corpus-label.ts";
import type { CanonicalAssignment, CorpusEntity } from "../domain/corpus.ts";
import type { Inference } from "./model.ts";
import { listSections, type InventoryThread } from "./inventory.ts";
import type { WorkstreamService } from "./service.ts";
import type {
  LiveOrganization,
  LiveOrganizationCounts,
  LiveOrganizationGroup,
  LiveOrganizationGroupMember,
  LiveOrganizationUnresolved,
} from "./contract.ts";

export type CoordinatorDeps = {
  db: Database;
  service: WorkstreamService;
  corpus: CorpusStore;
  analyzer: Analyzer;
  inference: Inference;
  model: () => Promise<ModelChoice>;
  classificationModel?: () => Promise<ModelChoice>;
  requests?: (threadId: string) => Promise<string[]>;
  projects?: () => Promise<{ id: string; name: string }[]>;
  members: (sectionId: string) => Promise<CleanupMember[]>;
  policy?: () => { capacity: number; collapseAt: number };
  onChange: () => void;
  now?: () => number;
};

const KEY = "live_organization";

const DEFAULT_COUNTS: LiveOrganizationCounts = {
  activeRoots: 0,
  completedRoots: 0,
  totalRoots: 0,
  unresolvedRoots: 0,
  activeWorkstreams: 0,
};

const DEFAULT_STATE: LiveOrganization = {
  status: "idle",
  progress: null,
  error: null,
  lastUpdatedAt: null,
  groups: [],
  unresolved: [],
  counts: DEFAULT_COUNTS,
};

export class Coordinator {
  private running = false;
  private rerunQueued = false;
  private disposed = false;
  private controller: AbortController | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSyncedHash: string | null = null;
  private forceNextRun = false;
  private activeRun: Promise<LiveOrganization> | null = null;

  constructor(private readonly deps: CoordinatorDeps) {
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

  state(): LiveOrganization {
    const raw = getMeta(this.deps.db, KEY);
    if (!raw) return DEFAULT_STATE;
    try {
      return JSON.parse(raw) as LiveOrganization;
    } catch {
      return DEFAULT_STATE;
    }
  }

  private save(state: LiveOrganization): LiveOrganization {
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

  async rebuild(): Promise<LiveOrganization> {
    this.lastSyncedHash = null;
    this.forceNextRun = true;
    if (this.running) {
      this.rerunQueued = true;
      await this.activeRun?.catch(() => {});
      return this.run();
    }
    return this.run();
  }

  async run(): Promise<LiveOrganization> {
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
  ): Promise<LiveOrganization> {
    const currentState = this.state();
    const sdk = (
      this.deps.service as unknown as { sdk: () => BbPluginApi["sdk"] }
    ).sdk();

    let passContext: {
      roots: InventoryThread[];
      isCompletedMap: Map<string, boolean>;
      assignments: Record<string, CanonicalAssignment>;
      selectedEntityIds: string[];
      entityToSection: Map<string, string>;
      appliedSectionIds: Map<string, string | null>;
      evidenceById: Map<string, string>;
      entities: CorpusEntity[];
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
      const isCompletedMap = new Map<string, boolean>();
      for (const root of roots) {
        const assessment = analysis[root.id];
        const done = Boolean(
          assessment &&
          isCurrent(assessment, root) &&
          assessment.state === "done",
        );
        isCompletedMap.set(root.id, done);
      }

      // Check if snapshot is identical to last completed run
      const catalogRev = this.deps.corpus.revision();
      const snapshotHash = createHash("sha256")
        .update(
          JSON.stringify({
            catalogRev,
            roots: roots.map((r) => [
              r.id,
              r.title,
              r.sectionId,
              isCompletedMap.get(r.id),
              this.deps.corpus.assignment(r.id).entityId,
              this.deps.corpus.assignment(r.id).status,
              this.deps.corpus.assignment(r.id).provenance,
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

      // Projects context
      const projects = new Map(
        ((await this.deps.projects?.()) ?? []).map((p) => [p.id, p.name]),
      );

      // 1. Classification stage
      const requestsById = new Map<string, string[]>();
      const evidenceById = new Map<string, string>();
      const pending: InventoryThread[] = [];

      for (const root of roots) {
        const assignment = this.deps.corpus.assignment(root.id);
        const requests = (await this.deps.requests?.(root.id)) ?? [];
        requestsById.set(root.id, requests);
        const evidence = classificationEvidence({
          requests,
          title: root.title,
          project: projects.get(root.projectId) ?? null,
        });
        evidenceById.set(root.id, evidence);

        // Manual assignment is authoritative; otherwise classify if missing or stale
        if (
          assignment.provenance !== "manual" &&
          !this.deps.corpus.isFresh(root.id, evidence)
        ) {
          pending.push(root);
        }
      }

      if (pending.length > 0) {
        const model = await this.deps.model();
        const classificationModel =
          (await this.deps.classificationModel?.()) ?? model;

        let completed = 0;
        let unresolved = 0;
        const cached = roots.length - pending.length;

        this.save({
          ...currentState,
          status: "classifying",
          progress: {
            stage: "classifying",
            completed: 0,
            total: pending.length,
            cached,
            unresolved: 0,
          },
          error: null,
        });

        const catalogRevBefore = this.deps.corpus.revision();
        let cursor = 0;
        let classifyError: unknown = null;

        const worker = async () => {
          while (
            !signal.aborted &&
            !this.disposed &&
            !classifyError &&
            cursor < pending.length
          ) {
            const thread = pending[cursor++]!;
            try {
              const threadEvidence = evidenceById.get(thread.id)!;
              const { value } = await this.deps.inference.run(
                "classify",
                {
                  prompt: `${thread.title}\n${analysis[thread.id]?.recap ?? ""}`,
                  entities: this.deps.corpus.list(),
                  project: projects.get(thread.projectId) ?? null,
                  requests: requestsById.get(thread.id),
                },
                {
                  model: classificationModel,
                  signal,
                  threadId: thread.id,
                  label: thread.title,
                },
              );

              if (signal.aborted || this.disposed) return;

              // Check if thread was manually assigned or cleared while inference was in-flight (Finding 3)
              const currentAssignment = this.deps.corpus.assignment(thread.id);
              if (currentAssignment.provenance === "manual") {
                completed++;
                continue;
              }

              // Check if thread was archived while inference was in-flight
              const liveThread = await sdk.threads
                .get({ threadId: thread.id })
                .catch(() => null);
              if (
                !liveThread ||
                liveThread.archivedAt !== null ||
                liveThread.visibility === "hidden"
              ) {
                this.rerunQueued = true;
                completed++;
                continue;
              }

              // Check if evidence changed while inference in-flight
              const liveTitle =
                liveThread.title ?? liveThread.titleFallback ?? "";
              if (liveTitle !== thread.title) {
                this.rerunQueued = true;
                completed++;
                continue;
              }

              const liveRequests =
                (await this.deps.requests?.(thread.id)) ?? [];
              if (
                classificationEvidence({
                  title: liveTitle,
                  requests: liveRequests,
                  project: projects.get(liveThread.projectId) ?? null,
                }) !== threadEvidence
              ) {
                this.rerunQueued = true;
                completed++;
                continue;
              }
              // Recheck after SDK/evidence awaits so a concurrent correction stays authoritative.
              if (
                this.deps.corpus.assignment(thread.id).provenance === "manual"
              ) {
                completed++;
                continue;
              }
              const entity = value.subjectId
                ? this.deps.corpus.list().find((e) => e.id === value.subjectId)
                : value.proposed
                  ? this.deps.corpus.rememberProposal(value.proposed)
                  : null;

              if (entity) {
                this.deps.corpus.assign(thread.id, entity.id, {
                  provenance: "automatic",
                  evidence: threadEvidence,
                });
              } else {
                // Persistent null result cached with automatic provenance (Finding 2)
                this.deps.corpus.assign(thread.id, null, {
                  provenance: "automatic",
                  evidence: threadEvidence,
                });
                unresolved++;
              }
              completed++;

              this.save({
                ...this.state(),
                progress: {
                  stage: "classifying",
                  completed,
                  total: pending.length,
                  cached,
                  unresolved,
                },
              });
            } catch (err) {
              classifyError ??= err;
            }
          }
        };

        await Promise.all(
          Array.from({ length: Math.min(3, pending.length) }, worker),
        );

        if (signal.aborted || this.disposed) return this.state();

        if (classifyError) {
          const errMsg =
            classifyError instanceof Error
              ? classifyError.message
              : String(classifyError);
          return this.save({
            ...currentState,
            status: "failed",
            error: errMsg,
            progress: null,
          });
        }
      }

      if (signal.aborted || this.disposed) return this.state();

      // 2. Derivation stage
      const entities = this.deps.corpus.list();
      const assignments = this.deps.corpus.assignments();

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
          const groups = this.deps.corpus.groups();
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
      const liveSections = await listSections(sdk);
      const groupBindings = new Map(this.deps.corpus.groups()); // sectionId -> entityId
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

      for (const entityId of selectedEntityIds) {
        const entity = entities.find((e) => e.id === entityId)!;
        const expectedName = corpusLabel(entityId, entities);

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
            this.deps.corpus.bindGroup(section.id, entityId);
            groupBindings.set(section.id, entityId); // Update local map (Finding 4)
          }
        }

        if (!section) {
          // Create a new native section owned by workstreams (Finding 7)
          const created = await sdk.threadSections.create({
            name: expectedName,
          });
          section = { id: created.id, name: created.name };
          const now = this.now();
          this.deps.db
            .prepare(
              `INSERT INTO ws_workstream (section_id, description, description_source, created_by, created_at, updated_at)
               VALUES (?, NULL, 'generated', 'workstreams', ?, ?)
               ON CONFLICT(section_id) DO UPDATE SET created_by = 'workstreams'`,
            )
            .run(created.id, now, now);
          this.deps.corpus.bindGroup(created.id, entityId);
          groupBindings.set(created.id, entityId); // Update local map (Finding 4)
          this.deps.service.seeSection(created.id, created.name);
        } else if (section.name !== expectedName) {
          // Rename section if entity name changed
          await sdk.threadSections.update({
            id: section.id,
            name: expectedName,
          });
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
          await sdk.threads.update({
            threadId: root.id,
            sectionId: targetSectionId,
          });
          this.deps.service.place(root.id, targetSectionId, "auto", null);
          this.deps.service.seeThread(
            root.id,
            targetSectionId,
            root.parentThreadId ?? null,
            root.title,
          );
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
          const activeMembers = members.filter((m) => m.archivedAt === null);
          if (activeMembers.length === 0) {
            // Check ownership safety policy (Finding 7)
            const wsRow = this.deps.db
              .prepare(
                "SELECT created_by FROM ws_workstream WHERE section_id = ?",
              )
              .get(section.id) as { created_by: string } | undefined;

            if (wsRow?.created_by === "workstreams") {
              await sdk.threadSections.delete({ id: section.id });
              this.deps.db
                .prepare("DELETE FROM ws_seen_section WHERE section_id = ?")
                .run(section.id);
              this.deps.db
                .prepare("DELETE FROM ws_workstream WHERE section_id = ?")
                .run(section.id);
            }
            this.deps.corpus.unbindGroup(section.id);
            groupBindings.delete(section.id);
          }
        }
      }

      // 4. Assemble LiveOrganizationState
      const finalState = this.assembleLiveOrganizationState({
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
            catalogRev: this.deps.corpus.revision(),
            roots: roots.map((r) => [
              r.id,
              r.title,
              appliedSectionIds.get(r.id) ?? r.sectionId,
              isCompletedMap.get(r.id),
              this.deps.corpus.assignment(r.id).entityId,
              this.deps.corpus.assignment(r.id).status,
              this.deps.corpus.assignment(r.id).provenance,
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
        const failedState = this.assembleLiveOrganizationState({
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

  private assembleLiveOrganizationState(options: {
    status: LiveOrganization["status"];
    error: string | null;
    roots: InventoryThread[];
    isCompletedMap: Map<string, boolean>;
    assignments: Record<string, CanonicalAssignment>;
    selectedEntityIds: string[];
    entityToSection: Map<string, string>;
    appliedSectionIds: Map<string, string | null>;
    evidenceById: Map<string, string>;
    entities: CorpusEntity[];
  }): LiveOrganization {
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

    const groupsMap = new Map<string, LiveOrganizationGroup>();
    for (const entityId of selectedEntityIds) {
      const entity = entities.find((e) => e.id === entityId);
      const name = entity ? corpusLabel(entityId, entities) : entityId;
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

    const unresolvedTasks: LiveOrganizationUnresolved[] = [];
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
            ? "Completed task; unresolved identity."
            : "Unresolved identity; remains unfiled.",
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
        const identityLabel = entity ? corpusLabel(entity.id, entities) : null;

        let reason: string;
        if (isCompleted) {
          reason = `Completed task; retained in ${group.name}.`;
        } else if (assignment.provenance === "manual") {
          reason = `Manually assigned to ${identityLabel}; grouped in ${group.name}.`;
        } else if (identityLabel && identityLabel !== group.name) {
          reason = `Classified as ${identityLabel}; grouped under ${group.name}.`;
        } else {
          reason = `Classified as ${group.name}.`;
        }

        group.roots.push({
          id: root.id,
          title: root.title,
          completed: isCompleted,
          identityId: assignment.entityId,
          identityLabel,
          provenance: assignment.provenance,
          reason,
        });
      } else {
        unresolvedTasks.push({
          id: root.id,
          title: root.title,
          completed: isCompleted,
          evidence: evidenceById.get(root.id) ?? null,
          reason: "No active home; remains unfiled.",
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
