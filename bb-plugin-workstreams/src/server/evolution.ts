/**
 * Applies notebook-driven workstream supervision through the existing proposal,
 * journal, and batch services. Model output is advisory; every action is
 * checked against the current root map before it can be shown or applied.
 */
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  appliedCopy,
  normalize,
  pendingCopy,
  proposalKey,
  snoozeKey,
  type Candidate,
  type ProposalKind,
  type Sensitivity,
} from "../domain/evolution.ts";
import type {
  SupervisionAction,
  SupervisionInput,
} from "../domain/supervision.ts";
import { isCurrent } from "../domain/analysis.ts";
import { ASSIGN_BATCH } from "../domain/organize.ts";
import { buildForest } from "../domain/tree.ts";
import type { Analyzer } from "./analyzer.ts";
import type { Bootstrap } from "./bootstrap.ts";
import { getMeta, setMeta, type Database } from "./db.ts";
import type { Journal } from "./journal.ts";
import type { WorkstreamMap } from "./map.ts";
import type { Inference } from "./model.ts";
import {
  UserError,
  type BatchPlan,
  type WorkstreamService,
} from "./service.ts";

type Sdk = BbPluginApi["sdk"];
export type ProposalStatus =
  | "pending"
  | "applying"
  | "applied"
  | "partial"
  | "undone"
  | "dismissed"
  | "expired";
export type ProposalView = {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  subject: string;
  sourceSectionId: string | null;
  sourceName: string;
  targetSectionId: string | null;
  targetName: string;
  threadIds: string[];
  entryId: string | null;
  acknowledged: boolean;
  text: string;
  accept: string;
  updatedAt: number;
  traceIds: string[];
  reason: string;
  confidence: number;
};
type Snapshot = Record<string, { revision: number; sectionId: string | null }>;
type Row = {
  id: string;
  key: string;
  kind: ProposalKind;
  status: ProposalStatus;
  subject: string;
  source_section_id: string;
  target_section_id: string | null;
  new_name: string | null;
  thread_ids: string;
  evidence_count: number;
  entry_id: string | null;
  acknowledged: number;
  created_at: number;
  updated_at: number;
  snapshot: string;
  reason: string;
  confidence: number;
};
type RootEvidence = {
  id: string;
  sectionId: string | null;
  title: string;
  revision: number;
  latestAttentionAt: number;
  sourceThreadId: string | null;
};
const UNSORTED = "";
const APPLIED_BANNER_MS = 7 * 24 * 60 * 60 * 1000;
const DESCRIBE_RETRY_MS = 60 * 60_000;
const SUPERVISION_INTERVAL: Record<Sensitivity, number> = {
  responsive: 2 * 60_000,
  balanced: 5 * 60_000,
  conservative: 10 * 60_000,
};
const MAX_OPEN = 3;

export class Evolution {
  private readonly assignedAt = new Map<string, number>();
  private readonly describedAt = new Map<string, number>();
  private ticking = false;
  private disposed = false;
  private generation = 0;
  private readonly controllers = new Set<AbortController>();

  constructor(
    private readonly deps: {
      sdk: () => Sdk;
      db: Database;
      service: WorkstreamService;
      journal: Journal;
      map: WorkstreamMap;
      analyzer: Analyzer;
      bootstrap: Bootstrap;
      inference: Inference;
      model: () => Promise<string>;
      settings: () => Promise<{ evolution: string; sensitivity: string }>;
      notebook: (
        threadId: string,
      ) => { text: string; updatedAt: number } | null;
      context: () => string;
      onChange: () => void;
      log: (message: string) => void;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      const threads = this.deps.service.threads();
      this.deps.map.refresh(threads, this.deps.analyzer.all());
      await this.describeMissing();
      if (!this.deps.bootstrap.isDone() || this.disposed) return;
      this.settleUndone();
      await this.expireStale();
      await this.supervise();
      await this.fileUnsorted();
    } catch (error) {
      this.deps.log(`Evolution pass failed: ${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  proposals(): ProposalView[] {
    const cutoff = this.now() - APPLIED_BANNER_MS;
    const rows = this.rows().filter(
      (row) =>
        row.status === "pending" ||
        ((row.status === "applied" || row.status === "partial") &&
          !row.acknowledged &&
          row.updated_at >= cutoff &&
          (!row.entry_id ||
            this.deps.journal.get(row.entry_id)?.status !== "undone")),
    );
    const traces = this.deps.inference.linked(
      "proposal",
      rows.map((row) => row.id),
    );
    return rows.map((row) => this.view(row, traces.get(row.id) ?? []));
  }

  async accept(id: string): Promise<ProposalView> {
    const claimed = this.deps.db
      .prepare(
        "UPDATE ws_proposal SET status = 'applying' WHERE id = ? AND status = 'pending'",
      )
      .run(id);
    const row = this.row(id);
    if (!row || claimed.changes === 0)
      throw new UserError("That proposal is no longer open.");
    try {
      const current = this.rootEvidence();
      const saved = this.snapshot(row);
      const shown = JSON.parse(row.thread_ids) as string[];
      const threadIds = shown.filter((threadId) => {
        const before = saved[threadId];
        const after = current.get(threadId);
        return (
          before &&
          after &&
          before.sectionId === after.sectionId &&
          before.sectionId === row.source_section_id &&
          before.revision === after.revision
        );
      });
      if (threadIds.length !== shown.length || !threadIds.length) {
        this.expire(row);
        throw new UserError("This no longer applies; nothing changed.");
      }
      const applied = await this.apply(row, threadIds);
      return this.view(
        applied,
        this.deps.inference.linked("proposal", [row.id]).get(row.id) ?? [],
      );
    } catch (error) {
      if (this.row(id)?.status === "applying") this.setStatus(row, "pending");
      throw error;
    }
  }

  dismiss(id: string): void {
    const row = this.row(id);
    if (!row || row.status !== "pending") return;
    this.setStatus(row, "dismissed");
    this.snooze(row);
    if (row.entry_id)
      this.deps.journal.update(row.entry_id, { status: "dismissed" });
    this.deps.onChange();
  }
  acknowledge(id: string): void {
    this.deps.db
      .prepare("UPDATE ws_proposal SET acknowledged = 1 WHERE id = ?")
      .run(id);
    this.deps.onChange();
  }

  private async supervise(): Promise<void> {
    const settings = await this.deps.settings();
    const sensitivity: Sensitivity = [
      "responsive",
      "balanced",
      "conservative",
    ].includes(settings.sensitivity)
      ? (settings.sensitivity as Sensitivity)
      : "responsive";
    const input = this.supervisionInput(sensitivity);
    const fingerprint = this.fingerprint(input, settings.evolution);
    const previous = this.readSnapshot();
    const now = this.now();
    const cached =
      previous?.fingerprint === fingerprint ? previous.candidates : null;
    if (
      !cached &&
      ((previous && now - previous.at < SUPERVISION_INTERVAL[sensitivity]) ||
        this.failureBackoff(fingerprint, now, sensitivity))
    )
      return;
    let candidates: Candidate[];
    let supervisionTraceId = cached ? (previous?.traceId ?? null) : null;
    if (cached) candidates = cached;
    else {
      const generation = this.generation;
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        const { value: actions, traceId } = await this.deps.inference.run(
          "supervision",
          input,
          {
            model: await this.deps.model(),
            label: `${input.workstreams.length} workstreams`,
            links: input.workstreams.map((workstream) => ({
              kind: "section",
              ref: workstream.id,
            })),
            signal: controller.signal,
          },
        );
        if (
          this.disposed ||
          generation !== this.generation ||
          this.fingerprint(
            this.supervisionInput(sensitivity),
            settings.evolution,
          ) !== fingerprint ||
          !(await this.actionsStillCurrent(actions, input))
        )
          return;
        this.deps.db
          .prepare("DELETE FROM ws_meta WHERE key = 'supervision_failure'")
          .run();
        candidates = this.validateActions(actions, input);
        supervisionTraceId = traceId;
        this.saveSnapshot({ fingerprint, at: now, candidates, traceId });
        this.deps.inference.annotate(traceId, {
          candidates: candidates.length,
          snapshot: fingerprint,
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          this.deps.log(
            `Workstream supervision failed; retaining last valid snapshot: ${error instanceof Error ? error.stack : String(error)}`,
          );
          this.saveFailure({ fingerprint, at: now });
        }
        return;
      } finally {
        this.controllers.delete(controller);
      }
    }
    if (settings.evolution !== "ask" && settings.evolution !== "auto") return;
    const open = this.openRows();
    const sources = new Set(open.map((row) => row.source_section_id));
    let count = open.length;
    for (const candidate of candidates) {
      if (count >= MAX_OPEN || sources.has(candidate.sourceSectionId)) continue;
      if (
        this.rows().some(
          (row) =>
            row.key === candidate.key &&
            row.status !== "expired" &&
            row.status !== "undone" &&
            row.status !== "dismissed",
        )
      )
        continue;
      if (this.isSnoozed(candidate)) continue;
      const row = this.insert(candidate);
      this.linkEvidence(row.id, candidate.threadIds);
      this.deps.inference.link(supervisionTraceId, {
        kind: "proposal",
        ref: row.id,
      });
      sources.add(candidate.sourceSectionId);
      count++;
      if (settings.evolution === "ask") {
        const entry = this.deps.journal.add({
          action: "proposal",
          source: "proposal",
          status: "pending",
          rationale: this.rationale(row, "Proposed: "),
          threads: this.threadRefs(candidate.threadIds),
          workstreams: this.workstreamRefs(row),
          undo: null,
        });
        this.deps.db
          .prepare("UPDATE ws_proposal SET entry_id = ? WHERE id = ?")
          .run(entry.id, row.id);
        this.deps.inference.copyLinks(
          { kind: "proposal", ref: row.id },
          { kind: "entry", ref: entry.id },
        );
        this.deps.onChange();
      } else await this.apply(row, candidate.threadIds);
    }
  }

  private supervisionInput(sensitivity: Sensitivity): SupervisionInput {
    const forest = buildForest(this.deps.service.threads());
    const placements = this.deps.service.state().placements;
    const map = this.deps.map.list();
    const workstreams = map.map((record) => ({
      id: record.sectionId,
      name: record.name,
      description: record.description,
      descriptionSource: record.descriptionSource as "user" | "generated",
      roots: forest.roots
        .filter(({ thread }) => thread.sectionId === record.sectionId)
        .map(({ thread }) => {
          const note = this.deps.notebook(thread.id);
          const analysis = this.deps.analyzer.get(thread.id);
          const placement = placements[thread.id];
          const movedAt =
            placement &&
            (placement.source === "user" || placement.source === "external")
              ? placement.at
              : null;
          return {
            id: thread.id,
            title: thread.title,
            recap: analysis?.recap ?? null,
            revision: thread.latestAttentionAt,
            notebook: note?.text ?? null,
            notebookUpdatedAt: note?.updatedAt ?? null,
            eligible:
              movedAt === null || this.now() - movedAt >= 14 * 24 * 60 * 60_000,
          };
        }),
    }));
    return { sensitivity, context: this.deps.context(), workstreams };
  }

  private fingerprint(input: SupervisionInput, mode: string): string {
    return JSON.stringify({
      mode,
      sensitivity: input.sensitivity,
      context: input.context,
      workstreams: input.workstreams.map((workstream) => ({
        id: workstream.id,
        name: workstream.name,
        description: workstream.description,
        roots: workstream.roots.map((root) => [
          root.id,
          root.title,
          root.revision,
          root.recap,
          root.notebookUpdatedAt,
          root.notebook,
          root.eligible,
        ]),
      })),
    });
  }

  private async actionsStillCurrent(
    actions: readonly SupervisionAction[],
    input: SupervisionInput,
  ): Promise<boolean> {
    const expected = new Map(
      input.workstreams.flatMap((workstream) =>
        workstream.roots.map(
          (root) =>
            [
              root.id,
              { revision: root.revision, sectionId: workstream.id },
            ] as const,
        ),
      ),
    );
    const ids = [...new Set(actions.flatMap((action) => action.threadIds))];
    for (const id of ids) {
      const before = expected.get(id);
      if (!before) return false;
      const live = await this.deps
        .sdk()
        .threads.get({ threadId: id })
        .catch(() => null);
      if (
        !live ||
        live.archivedAt !== null ||
        live.visibility === "hidden" ||
        (live.sectionId ?? null) !== before.sectionId ||
        (live.latestAttentionAt ?? live.updatedAt) !== before.revision
      )
        return false;
    }
    return true;
  }

  private validateActions(
    actions: readonly SupervisionAction[],
    input: SupervisionInput,
  ): Candidate[] {
    const active = new Map(
      input.workstreams.flatMap((workstream) =>
        workstream.roots.map(
          (root) => [root.id, { ...root, sectionId: workstream.id }] as const,
        ),
      ),
    );
    const ws = new Map(
      input.workstreams.map((workstream) => [workstream.id, workstream]),
    );
    const snoozes = new Map(
      (
        this.deps.db
          .prepare("SELECT key,evidence_count FROM ws_snooze")
          .all() as { key: string; evidence_count: number }[]
      ).map((row) => [row.key, row.evidence_count]),
    );
    const made: Candidate[] = [];
    for (const action of actions) {
      const source = ws.get(action.sourceSectionId);
      const target = action.targetSectionId
        ? ws.get(action.targetSectionId)
        : undefined;
      if (!source || (action.kind !== "spin-out" && !target)) continue;
      if (
        action.kind === "merge" &&
        action.threadIds.length !==
          source.roots.filter((root) => root.eligible).length
      )
        continue;
      const roots = action.threadIds.map((id) => active.get(id));
      if (
        roots.some(
          (root) => !root || root.sectionId !== source.id || !root.eligible,
        )
      )
        continue;
      if (action.kind === "spin-out" && action.threadIds.length < 2) continue;
      if (
        action.kind !== "spin-out" &&
        !target?.roots.some((root) => root.eligible)
      )
        continue;
      const subject = action.kind === "spin-out" ? action.name! : target!.name;
      const key = proposalKey(
        action.kind,
        source.id,
        action.kind === "spin-out" ? subject : target!.id,
      );
      const snapshot = Object.fromEntries(
        action.threadIds.map((id) => [
          id,
          { revision: active.get(id)!.revision, sectionId: source.id },
        ]),
      );
      const evidenceCount = this.evidenceSignal(action, input);
      const snoozed = snoozes.get(snoozeKey(key));
      if (snoozed !== undefined && snoozed === evidenceCount) continue;
      made.push({
        key,
        kind: action.kind,
        subject,
        sourceSectionId: source.id,
        targetSectionId: target?.id ?? null,
        newName: action.kind === "spin-out" ? action.name : null,
        threadIds: action.threadIds,
        evidenceCount,
        reason: action.reason,
        confidence: action.confidence,
        snapshot,
      });
    }
    return made;
  }

  private evidenceSignal(
    action: SupervisionAction,
    input: SupervisionInput,
  ): number {
    const relevant = input.workstreams
      .filter(
        (workstream) =>
          workstream.id === action.sourceSectionId ||
          workstream.id === action.targetSectionId,
      )
      .map((workstream) => ({
        id: workstream.id,
        name: workstream.name,
        description: workstream.description,
        roots: workstream.roots
          .filter((root) => root.eligible)
          .map((root) => [
            root.id,
            root.title,
            root.revision,
            root.recap,
            root.notebookUpdatedAt,
            root.notebook,
          ]),
      }));
    // The existing integer column stores a content signature, not a subject
    // count, so the same idea sleeps until relevant evidence actually changes.
    const serialized = JSON.stringify({
      relevant,
      context: input.context,
      ids: action.threadIds,
    });
    let hash = 2166136261;
    for (const char of serialized)
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return hash >>> 0;
  }

  private readSnapshot(): {
    fingerprint: string;
    at: number;
    candidates: Candidate[];
    traceId?: string | null;
  } | null {
    const raw = getMeta(this.deps.db, "supervision_snapshot");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as {
        fingerprint: string;
        at: number;
        candidates: Candidate[];
        traceId?: string | null;
      };
    } catch {
      return null;
    }
  }
  private saveSnapshot(value: {
    fingerprint: string;
    at: number;
    candidates: Candidate[];
    traceId?: string | null;
  }) {
    setMeta(this.deps.db, "supervision_snapshot", JSON.stringify(value));
  }
  private failureBackoff(
    fingerprint: string,
    now: number,
    sensitivity: Sensitivity,
  ): boolean {
    const raw = getMeta(this.deps.db, "supervision_failure");
    if (!raw) return false;
    try {
      const failure = JSON.parse(raw) as { fingerprint: string; at: number };
      return (
        failure.fingerprint === fingerprint &&
        now - failure.at < SUPERVISION_INTERVAL[sensitivity]
      );
    } catch {
      return false;
    }
  }
  private saveFailure(value: { fingerprint: string; at: number }) {
    setMeta(this.deps.db, "supervision_failure", JSON.stringify(value));
  }
  private isSnoozed(candidate: Candidate): boolean {
    const row = this.deps.db
      .prepare("SELECT evidence_count FROM ws_snooze WHERE key = ?")
      .get(snoozeKey(candidate.key)) as { evidence_count: number } | undefined;
    return row?.evidence_count === candidate.evidenceCount;
  }

  private openRows(): Row[] {
    // Applied notices remain visible for Undo, but do not hold proposal slots
    // hostage until the user acknowledges every historical banner.
    return this.rows().filter(
      (row) => row.status === "pending" || row.status === "applying",
    );
  }
  private async expireStale(): Promise<void> {
    const roots = this.rootEvidence();
    for (const row of this.rows().filter(
      (r) => r.status === "pending" && r.source_section_id !== UNSORTED,
    )) {
      const snapshot = this.snapshot(row);
      const ids = JSON.parse(row.thread_ids) as string[];
      if (
        ids.some(
          (id) =>
            !roots.has(id) ||
            !snapshot[id] ||
            roots.get(id)!.latestAttentionAt !== snapshot[id]!.revision ||
            roots.get(id)!.sectionId !== snapshot[id]!.sectionId,
        )
      )
        this.expire(row);
    }
  }
  private expire(row: Row): void {
    this.setStatus(row, "expired");
    if (row.entry_id)
      this.deps.journal.update(row.entry_id, {
        status: "dismissed",
        detail: "No longer applies.",
      });
    this.deps.onChange();
  }
  private snapshot(row: Row): Snapshot {
    try {
      return JSON.parse(row.snapshot) as Snapshot;
    } catch {
      return {};
    }
  }
  private rootEvidence(): Map<string, RootEvidence> {
    const forest = buildForest(this.deps.service.threads());
    return new Map(
      forest.roots.map(({ thread }) => [
        thread.id,
        {
          id: thread.id,
          sectionId: thread.sectionId,
          title: thread.title,
          revision: thread.latestAttentionAt,
          latestAttentionAt: thread.latestAttentionAt,
          sourceThreadId: thread.sourceThreadId,
        },
      ]),
    );
  }
  private async apply(row: Row, threadIds?: readonly string[]): Promise<Row> {
    const ids = threadIds ?? (JSON.parse(row.thread_ids) as string[]);
    const from =
      row.source_section_id === UNSORTED ? null : row.source_section_id;
    const plan: BatchPlan =
      row.kind === "spin-out"
        ? {
            creates: [{ key: "new", name: row.new_name ?? row.subject }],
            renames: [],
            moves: ids.map((threadId) => ({ threadId, from, to: "new" })),
          }
        : {
            creates: [],
            renames: [],
            moves: ids.map((threadId) => ({
              threadId,
              from,
              to: row.target_section_id,
            })),
          };
    let result: Awaited<ReturnType<WorkstreamService["applyBatch"]>>;
    try {
      result = await this.deps.service.applyBatch(
        plan,
        from === null ? "auto" : "proposal",
        this.rationale(row, ""),
        { action: from === null ? "move" : "proposal", into: row.entry_id },
      );
    } catch (error) {
      const failed = this.deps.journal
        .list({ limit: 20, external: true })
        .find(
          (entry) =>
            entry.action === "proposal" &&
            entry.status === "failed" &&
            entry.threads.some((thread) => ids.includes(thread.id)),
        );
      if (failed) {
        this.deps.db
          .prepare(
            "UPDATE ws_proposal SET status='partial', entry_id=?, updated_at=? WHERE id=?",
          )
          .run(failed.id, this.now(), row.id);
        this.deps.inference.copyLinks(
          { kind: "proposal", ref: row.id },
          { kind: "entry", ref: failed.id },
        );
        this.deps.onChange();
        return this.row(row.id)!;
      }
      throw error;
    }
    const { entry, created } = result;
    if (!entry) {
      this.expire(row);
      return this.row(row.id)!;
    }
    this.deps.inference.copyLinks(
      { kind: "proposal", ref: row.id },
      { kind: "entry", ref: entry.id },
    );
    const target =
      row.kind === "spin-out"
        ? (created.get("new") ?? null)
        : row.target_section_id;
    this.deps.db
      .prepare(
        "UPDATE ws_proposal SET status=?,entry_id=?,target_section_id=?,thread_ids=?,updated_at=? WHERE id=?",
      )
      .run(
        entry.status === "partial" ? "partial" : "applied",
        entry.id,
        target,
        JSON.stringify(entry.threads.map((t) => t.id)),
        this.now(),
        row.id,
      );
    this.deps.onChange();
    return this.row(row.id)!;
  }
  settleUndone(): void {
    for (const row of this.rows()) {
      if (
        (row.status !== "applied" && row.status !== "partial") ||
        !row.entry_id ||
        this.deps.journal.get(row.entry_id)?.status !== "undone"
      )
        continue;
      this.setStatus(row, "undone");
      this.snooze(row);
    }
  }

  private async fileUnsorted(): Promise<void> {
    const threads = this.deps.service.threads();
    const forest = buildForest(threads);
    const placements = this.deps.service.state().placements;
    const records = this.deps.map.list();
    const byName = new Map<string, (typeof records)[number]>();
    for (const record of records)
      for (const name of [record.name, ...record.aliases])
        byName.set(normalize(name), record);
    const analysis = this.deps.analyzer.all();
    const pendingThreads = new Set(
      this.rows()
        .filter((row) => row.status === "pending")
        .flatMap((row) => JSON.parse(row.thread_ids) as string[]),
    );
    const unsorted = forest.roots
      .map(({ thread }) => thread)
      .filter((thread) => !thread.sectionId && !pendingThreads.has(thread.id))
      .filter((thread) => {
        const p = placements[thread.id];
        return !(p && (p.source === "user" || p.source === "external"));
      })
      .filter(
        (thread) =>
          thread.sourceThreadId !== null ||
          isCurrent(analysis[thread.id], thread),
      );
    const toAssign: typeof unsorted = [];
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    for (const thread of unsorted) {
      const fork = thread.sourceThreadId
        ? forest.rootOf.get(thread.sourceThreadId)
        : undefined;
      const sourceSection = fork ? byId.get(fork.id)?.sectionId : null;
      const home = sourceSection
        ? records.find((record) => record.sectionId === sourceSection)
        : undefined;
      if (home) {
        await this.fileOne(thread.id, home.sectionId, home.name, []);
        continue;
      }
      const subject = analysis[thread.id]?.subject;
      const target = subject ? byName.get(normalize(subject)) : undefined;
      if (target) {
        await this.fileOne(thread.id, target.sectionId, target.name, [
          analysis[thread.id]?.traceId,
        ]);
        continue;
      }
      if (this.assignedAt.get(thread.id) !== thread.latestAttentionAt)
        toAssign.push(thread);
    }
    if (!toAssign.length) return;
    const batch = toAssign.slice(0, ASSIGN_BATCH);
    for (const thread of batch)
      this.assignedAt.set(thread.id, thread.latestAttentionAt);
    const { value: assignments, traceId } = await this.deps.inference.run(
      "file-unsorted",
      {
        workstreams: records.map((record) => ({
          name: record.name,
          description: record.description,
          aliases: record.aliases,
        })),
        threads: batch.map((thread) => ({
          id: thread.id,
          title: thread.title,
          subject: analysis[thread.id]?.subject ?? null,
          recap: analysis[thread.id]?.recap ?? null,
        })),
      },
      {
        model: await this.deps.model(),
        label: batch.map((thread) => thread.title).join(" · "),
        links: batch.map((thread) => ({ kind: "thread", ref: thread.id })),
      },
    );
    const filed: string[] = [];
    const created: string[] = [];
    const made = new Map<string, { sectionId: string; name: string }>();
    for (const assignment of assignments) {
      if (
        assignment.confidence !== "high" ||
        assignment.target.kind === "unsure"
      )
        continue;
      let target: { sectionId: string; name: string } | undefined;
      if (assignment.target.kind === "existing") {
        const targetName = assignment.target.name;
        const record = records.find((r) => r.name === targetName);
        if (record) target = { sectionId: record.sectionId, name: record.name };
      }
      if (assignment.target.kind === "new") {
        const key = normalize(assignment.target.name);
        target = made.get(key);
        if (!target) {
          const createdRecord = await this.deps.service.createWorkstream(
            assignment.target.name,
            "auto",
          );
          target = {
            sectionId: createdRecord.sectionId,
            name: assignment.target.name,
          };
          made.set(key, target);
          created.push(assignment.target.name);
        }
      }
      if (!target) continue;
      await this.fileOne(assignment.id, target.sectionId, target.name, [
        traceId,
        analysis[assignment.id]?.traceId,
      ]);
      filed.push(assignment.id);
    }
    this.deps.inference.annotate(traceId, {
      filed,
      created,
      rule: "High-confidence picks are filed; high-confidence new picks create a workstream and file the thread.",
    });
  }
  private async fileOne(
    threadId: string,
    sectionId: string,
    name: string,
    traceIds: readonly (string | null | undefined)[],
  ) {
    const row = this.insert({
      key: `move:${UNSORTED}:${threadId}`,
      kind: "move",
      subject: name,
      sourceSectionId: UNSORTED,
      targetSectionId: sectionId,
      newName: null,
      threadIds: [threadId],
      evidenceCount: 1,
      reason: "Filed an Unsorted root.",
      confidence: 1,
      snapshot: {
        [threadId]: {
          revision: this.rootEvidence().get(threadId)?.revision ?? 0,
          sectionId: null,
        },
      },
    });
    this.deps.inference.link(traceIds, { kind: "proposal", ref: row.id });
    await this.apply(row, [threadId]);
  }
  private async describeMissing(): Promise<void> {
    const threads = this.deps.service.threads();
    const forest = buildForest(threads);
    const missing = this.deps.map
      .list()
      .filter(
        (record) =>
          !record.description && record.descriptionSource === "generated",
      )
      .map((record) => ({
        record,
        roots: forest.roots
          .filter((root) => root.thread.sectionId === record.sectionId)
          .map((root) => ({
            title: root.thread.title,
            subject: this.deps.analyzer.get(root.thread.id)?.subject ?? null,
          })),
      }))
      .filter(
        (item) =>
          item.roots.length &&
          this.now() - (this.describedAt.get(item.record.sectionId) ?? 0) >
            DESCRIBE_RETRY_MS,
      )
      .slice(0, 8);
    if (!missing.length) return;
    for (const item of missing)
      this.describedAt.set(item.record.sectionId, this.now());
    const { value } = await this.deps.inference.run(
      "describe",
      missing.map((item) => ({ name: item.record.name, roots: item.roots })),
      {
        model: await this.deps.model(),
        label: missing.map((item) => item.record.name).join(", "),
        links: missing.map((item) => ({
          kind: "section",
          ref: item.record.sectionId,
        })),
      },
    );
    for (const item of missing) {
      const description = value[item.record.name];
      if (description)
        this.deps.map.describe(item.record.sectionId, description);
    }
    this.deps.onChange();
  }

  private insert(candidate: Candidate): Row {
    const at = this.now();
    const row = {
      id: randomUUID(),
      key: candidate.key,
      kind: candidate.kind,
      status: "pending" as const,
      subject: candidate.subject,
      source_section_id: candidate.sourceSectionId,
      target_section_id: candidate.targetSectionId,
      new_name: candidate.newName,
      thread_ids: JSON.stringify(candidate.threadIds),
      evidence_count: candidate.evidenceCount,
      snapshot: JSON.stringify(candidate.snapshot),
      reason: candidate.reason,
      confidence: candidate.confidence,
      entry_id: null,
      acknowledged: 0,
      created_at: at,
      updated_at: at,
    };
    this.deps.db
      .prepare(
        `INSERT INTO ws_proposal (id,key,kind,status,subject,source_section_id,target_section_id,new_name,thread_ids,evidence_count,snapshot,reason,confidence,entry_id,acknowledged,created_at,updated_at)
      VALUES (@id,@key,@kind,@status,@subject,@source_section_id,@target_section_id,@new_name,@thread_ids,@evidence_count,@snapshot,@reason,@confidence,@entry_id,@acknowledged,@created_at,@updated_at)`,
      )
      .run(row);
    return row;
  }
  private rows(): Row[] {
    return this.deps.db
      .prepare("SELECT * FROM ws_proposal ORDER BY updated_at DESC LIMIT 500")
      .all() as Row[];
  }
  private row(id: string): Row | undefined {
    return this.deps.db
      .prepare("SELECT * FROM ws_proposal WHERE id = ?")
      .get(id) as Row | undefined;
  }
  private setStatus(row: Row, status: ProposalStatus) {
    this.deps.db
      .prepare("UPDATE ws_proposal SET status=?,updated_at=? WHERE id=?")
      .run(status, this.now(), row.id);
  }
  private snooze(row: Row) {
    this.deps.db
      .prepare(
        `INSERT INTO ws_snooze (key,evidence_count,at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET evidence_count=excluded.evidence_count,at=excluded.at`,
      )
      .run(snoozeKey(row.key), row.evidence_count, this.now());
  }
  private linkEvidence(id: string, threadIds: readonly string[]) {
    this.deps.inference.link(
      threadIds.map((threadId) => this.deps.analyzer.get(threadId)?.traceId),
      { kind: "proposal", ref: id },
    );
  }
  private nameOf(id: string | null): string {
    return !id
      ? "Unsorted"
      : (this.deps.map.get(id)?.name ?? "a deleted workstream");
  }
  private rationale(row: Row, prefix: string): string {
    const n = (JSON.parse(row.thread_ids) as string[]).length;
    const threads = `${n} thread${n === 1 ? "" : "s"}`;
    const source = this.nameOf(row.source_section_id || null);
    if (row.kind === "spin-out") return `${prefix}${row.reason} (${threads})`;
    const target = this.nameOf(row.target_section_id);
    if (row.kind === "merge")
      return `${prefix}${row.reason} (${source} into ${target})`;
    return `${prefix}${row.reason} (${threads}: ${source} → ${target})`;
  }
  private threadRefs(ids: readonly string[]) {
    const titles = new Map(
      this.deps.service.threads().map((thread) => [thread.id, thread.title]),
    );
    return ids.map((id) => ({ id, name: titles.get(id) ?? id }));
  }
  private workstreamRefs(row: Row) {
    return [row.source_section_id || null, row.target_section_id]
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id, name: this.nameOf(id) }));
  }
  private view(row: Row, traceIds: string[]): ProposalView {
    const threadIds = JSON.parse(row.thread_ids) as string[];
    const sourceName = this.nameOf(row.source_section_id || null);
    const targetName =
      row.kind === "spin-out" && !row.target_section_id
        ? (row.new_name ?? row.subject)
        : this.nameOf(row.target_section_id);
    const pending = pendingCopy(
      row.kind,
      targetName,
      threadIds.length - 1,
      sourceName,
    );
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      subject: row.subject,
      sourceSectionId: row.source_section_id || null,
      sourceName,
      targetSectionId: row.target_section_id,
      targetName,
      threadIds,
      entryId: row.entry_id,
      acknowledged: row.acknowledged === 1,
      text:
        row.status === "pending"
          ? pending.text
          : appliedCopy(sourceName, targetName),
      accept: pending.accept,
      updatedAt: row.updated_at,
      traceIds,
      reason: row.reason,
      confidence: row.confidence,
    };
  }
}
