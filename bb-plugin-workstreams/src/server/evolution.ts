/**
 * Steady-state evolution (SPEC §8, §9): turns the deterministic proposals from
 * `domain/evolution.ts` into applied or pending changes, files Unsorted roots
 * that analysis places confidently (D8), and fills in missing descriptions.
 *
 * Every change runs through the journal as one undoable batch. An undone or
 * dismissed proposal is snoozed until its subject gains two more roots. None
 * of this runs until the one-time bootstrap is applied or skipped.
 */
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  appliedCopy,
  detectProposals,
  normalize,
  pendingCopy,
  type Candidate,
  type EvolutionRoot,
  type ProposalKind,
  type Sensitivity,
} from "../domain/evolution.ts";
import { isCurrent } from "../domain/analysis.ts";
import {
  ASSIGN_BATCH,
  assignPrompt,
  describePrompt,
  parseAssignments,
  parseDescriptions,
} from "../domain/organize.ts";
import { buildForest } from "../domain/tree.ts";
import type { Analyzer } from "./analyzer.ts";
import type { Bootstrap } from "./bootstrap.ts";
import type { Database } from "./db.ts";
import type { Journal } from "./journal.ts";
import type { WorkstreamMap } from "./map.ts";
import {
  UserError,
  type BatchPlan,
  type WorkstreamService,
} from "./service.ts";

type Sdk = BbPluginApi["sdk"];

export type ProposalStatus =
  "pending" | "applied" | "partial" | "undone" | "dismissed" | "expired";

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
  /** Banner text (SPEC §9 copy) and the accept button's label. */
  text: string;
  accept: string;
  updatedAt: number;
};

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
};

/** Unsorted as a proposal source; the column is non-null. */
const UNSORTED = "";
const APPLIED_BANNER_MS = 7 * 24 * 60 * 60 * 1000;
const ARCHIVE_CACHE_MS = 10 * 60_000;
const WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export class Evolution {
  private archived: { at: number; roots: EvolutionRoot[] } | null = null;
  /** Unsorted roots already offered to the assignment model, by revision. */
  private readonly assignedAt = new Map<string, number>();
  private ticking = false;

  constructor(
    private readonly deps: {
      sdk: () => Sdk;
      db: Database;
      service: WorkstreamService;
      journal: Journal;
      map: WorkstreamMap;
      analyzer: Analyzer;
      bootstrap: Bootstrap;
      complete: (prompt: string, model: string) => Promise<{ text: string }>;
      model: () => Promise<string>;
      settings: () => Promise<{ evolution: string; sensitivity: string }>;
      onChange: () => void;
      log: (message: string) => void;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** One pass: refresh evidence, then propose, apply, and file. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const threads = this.deps.service.threads();
      this.deps.map.refresh(threads, this.deps.analyzer.all());
      if (!this.deps.bootstrap.isDone()) return;
      this.settleUndone();
      await this.propose();
      await this.fileUnsorted();
      await this.describeMissing();
    } catch (error) {
      this.deps.log(`Evolution pass failed: ${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  proposals(): ProposalView[] {
    const cutoff = this.now() - APPLIED_BANNER_MS;
    return this.rows()
      .filter(
        (row) =>
          row.status === "pending" ||
          ((row.status === "applied" || row.status === "partial") &&
            !row.acknowledged &&
            row.updated_at >= cutoff),
      )
      .map((row) => this.view(row));
  }

  async accept(id: string): Promise<ProposalView> {
    const row = this.row(id);
    if (!row || row.status !== "pending")
      throw new UserError("That proposal is no longer open.");
    const fresh = (await this.candidates(false)).find((c) => c.key === row.key);
    if (!fresh && row.source_section_id !== UNSORTED) {
      this.setStatus(row, "expired");
      if (row.entry_id)
        this.deps.journal.update(row.entry_id, {
          status: "dismissed",
          detail: "No longer applies.",
        });
      throw new UserError("This no longer applies; nothing changed.");
    }
    return this.view(await this.apply(row, fresh?.threadIds));
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

  /** "OK" on an applied banner. */
  acknowledge(id: string): void {
    this.deps.db
      .prepare("UPDATE ws_proposal SET acknowledged = 1 WHERE id = ?")
      .run(id);
    this.deps.onChange();
  }

  private async propose(): Promise<void> {
    const settings = await this.deps.settings();
    for (const candidate of await this.candidates(true)) {
      const row = this.insert(candidate);
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
        this.deps.onChange();
      } else await this.apply(row, candidate.threadIds);
    }
  }

  /** Candidates the evidence supports; `fresh` drops ones already raised. */
  private async candidates(fresh: boolean): Promise<Candidate[]> {
    const threads = this.deps.service.threads();
    const forest = buildForest(threads);
    const placements = this.deps.service.state().placements;
    const liveRoots = forest.roots.map(({ thread }) => thread);
    const subjects = this.deps.analyzer.subjectsOf(liveRoots.map((t) => t.id));
    const moved = (id: string) => {
      const p = placements[id];
      return p && (p.source === "user" || p.source === "external")
        ? p.at
        : null;
    };
    const roots: EvolutionRoot[] = [
      ...liveRoots.map((t) => ({
        id: t.id,
        sectionId: t.sectionId,
        subject: subjects.get(t.id) ?? null,
        active: true,
        lastActiveAt: t.latestAttentionAt,
        userMovedAt: moved(t.id),
      })),
      ...(await this.archivedRoots()),
    ];
    const rows = this.rows();
    const open = rows.filter((r) => r.status === "pending");
    const raised = new Set(
      rows
        .filter((r) => r.status !== "expired")
        .filter((r) => r.status !== "undone" && r.status !== "dismissed")
        .map((r) => r.key),
    );
    const snoozed = new Map(
      (
        this.deps.db
          .prepare("SELECT key, evidence_count FROM ws_snooze")
          .all() as { key: string; evidence_count: number }[]
      ).map((r) => [r.key, r.evidence_count]),
    );
    const settings = await this.deps.settings();
    const candidates = detectProposals(
      roots,
      this.deps.map
        .list()
        .map((r) => ({ id: r.sectionId, name: r.name, aliases: r.aliases })),
      {
        now: this.now(),
        sensitivity: (["responsive", "balanced", "conservative"].includes(
          settings.sensitivity,
        )
          ? settings.sensitivity
          : "responsive") as Sensitivity,
        snoozed,
        openSources: fresh
          ? new Set(open.map((r) => r.source_section_id))
          : new Set(),
        openCount: fresh ? open.length : 0,
      },
    );
    return fresh ? candidates.filter((c) => !raised.has(c.key)) : candidates;
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
    const { entry, created } = await this.deps.service.applyBatch(
      plan,
      from === null ? "auto" : "proposal",
      this.rationale(row, ""),
      { action: "proposal", into: row.entry_id },
    );
    const target =
      row.kind === "spin-out"
        ? (created.get("new") ?? null)
        : row.target_section_id;
    this.deps.db
      .prepare(
        `UPDATE ws_proposal SET status = ?, entry_id = ?, target_section_id = ?, thread_ids = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        entry
          ? entry.status === "partial"
            ? "partial"
            : "applied"
          : "expired",
        entry?.id ?? row.entry_id,
        target,
        JSON.stringify(entry ? entry.threads.map((t) => t.id) : ids),
        this.now(),
        row.id,
      );
    this.deps.onChange();
    return this.row(row.id)!;
  }

  /** Undone proposals are snoozed like dismissed ones. */
  private settleUndone(): void {
    for (const row of this.rows()) {
      if (
        (row.status !== "applied" && row.status !== "partial") ||
        !row.entry_id
      )
        continue;
      if (this.deps.journal.get(row.entry_id)?.status !== "undone") continue;
      this.setStatus(row, "undone");
      this.snooze(row);
    }
  }

  /**
   * Unsorted roots: file under a workstream whose name or alias is the root's
   * subject, or that the assignment model picks with high confidence (D8).
   * A root the user moved to Unsorted recently stays there.
   */
  private async fileUnsorted(): Promise<void> {
    const threads = this.deps.service.threads();
    const forest = buildForest(threads);
    const placements = this.deps.service.state().placements;
    const records = this.deps.map.list();
    const byName = new Map<string, (typeof records)[number]>();
    for (const r of records)
      for (const name of [r.name, ...r.aliases]) byName.set(normalize(name), r);
    const analysis = this.deps.analyzer.all();
    const pendingThreads = new Set(
      this.rows()
        .filter((r) => r.status === "pending")
        .flatMap((r) => JSON.parse(r.thread_ids) as string[]),
    );
    const unsorted = forest.roots
      .map(({ thread }) => thread)
      .filter((t) => !t.sectionId && !pendingThreads.has(t.id))
      .filter((t) => {
        const p = placements[t.id];
        return !(p && (p.source === "user" || p.source === "external"));
      })
      .filter((t) => isCurrent(analysis[t.id], t));
    const toAssign: typeof unsorted = [];
    for (const thread of unsorted) {
      const subject = analysis[thread.id]?.subject;
      const target = subject ? byName.get(normalize(subject)) : undefined;
      if (target) await this.fileOne(thread.id, target.sectionId, target.name);
      else if (this.assignedAt.get(thread.id) !== thread.latestAttentionAt)
        toAssign.push(thread);
    }
    if (!toAssign.length || !records.length) return;
    const batch = toAssign.slice(0, ASSIGN_BATCH);
    for (const t of batch) this.assignedAt.set(t.id, t.latestAttentionAt);
    const { text } = await this.deps.complete(
      assignPrompt({
        workstreams: records.map((r) => ({
          name: r.name,
          description: r.description,
        })),
        threads: batch.map((t) => ({
          id: t.id,
          title: t.title,
          subject: analysis[t.id]?.subject ?? null,
          recap: analysis[t.id]?.recap ?? null,
        })),
      }),
      await this.deps.model(),
    );
    const assignments = parseAssignments(
      text,
      batch.map((t) => t.id),
      records.map((r) => r.name),
    );
    for (const a of assignments) {
      if (a.target.kind !== "existing" || a.confidence !== "high") continue;
      const name = a.target.name;
      const record = records.find((r) => r.name === name);
      if (record) await this.fileOne(a.id, record.sectionId, record.name);
    }
  }

  private async fileOne(threadId: string, sectionId: string, name: string) {
    const row = this.insert({
      key: `move:${UNSORTED}:${threadId}`,
      kind: "move",
      subject: name,
      sourceSectionId: UNSORTED,
      targetSectionId: sectionId,
      newName: null,
      threadIds: [threadId],
      evidenceCount: 1,
    });
    await this.apply(row, [threadId]);
  }

  /** One call per pass for workstreams that have no description yet. */
  private async describeMissing(): Promise<void> {
    const threads = this.deps.service.threads();
    const forest = buildForest(threads);
    const subjects = this.deps.analyzer.subjectsOf(
      forest.roots.map((r) => r.thread.id),
    );
    const missing = this.deps.map
      .list()
      .filter((r) => !r.description && r.descriptionSource === "generated")
      .map((r) => ({
        record: r,
        roots: forest.roots
          .filter((root) => root.thread.sectionId === r.sectionId)
          .map((root) => ({
            title: root.thread.title,
            subject: subjects.get(root.thread.id) ?? null,
          })),
      }))
      .filter((m) => m.roots.length > 0)
      .slice(0, 8);
    if (!missing.length) return;
    const { text } = await this.deps.complete(
      describePrompt(
        missing.map((m) => ({ name: m.record.name, roots: m.roots })),
      ),
      await this.deps.model(),
    );
    const descriptions = parseDescriptions(
      text,
      missing.map((m) => m.record.name),
    );
    for (const m of missing) {
      const description = descriptions[m.record.name];
      if (description) this.deps.map.describe(m.record.sectionId, description);
    }
    this.deps.onChange();
  }

  private async archivedRoots(): Promise<EvolutionRoot[]> {
    if (this.archived && this.now() - this.archived.at < ARCHIVE_CACHE_MS)
      return this.archived.roots;
    const sdk = this.deps.sdk();
    const cutoff = this.now() - WINDOW_MS;
    const found: { id: string; sectionId: string | null; at: number }[] = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await sdk.threads.list({
        archived: true,
        includeHidden: false,
        limit: 100,
        offset,
      });
      for (const t of page)
        if (
          !t.parentThreadId &&
          t.visibility !== "hidden" &&
          t.updatedAt >= cutoff
        )
          found.push({
            id: t.id,
            sectionId: t.sectionId ?? null,
            at: t.latestAttentionAt ?? t.updatedAt,
          });
      if (page.length < 100) break;
    }
    const subjects = this.deps.analyzer.subjectsOf(found.map((f) => f.id));
    const roots = found.map((f) => ({
      id: f.id,
      sectionId: f.sectionId,
      subject: subjects.get(f.id) ?? null,
      active: false,
      lastActiveAt: f.at,
      userMovedAt: null,
    }));
    this.archived = { at: this.now(), roots };
    return roots;
  }

  private insert(candidate: Candidate): Row {
    const at = this.now();
    const row: Row = {
      id: randomUUID(),
      key: candidate.key,
      kind: candidate.kind,
      status: "pending",
      subject: candidate.subject,
      source_section_id: candidate.sourceSectionId,
      target_section_id: candidate.targetSectionId,
      new_name: candidate.newName,
      thread_ids: JSON.stringify(candidate.threadIds),
      evidence_count: candidate.evidenceCount,
      entry_id: null,
      acknowledged: 0,
      created_at: at,
      updated_at: at,
    };
    this.deps.db
      .prepare(
        `INSERT INTO ws_proposal (id, key, kind, status, subject, source_section_id, target_section_id, new_name,
           thread_ids, evidence_count, entry_id, acknowledged, created_at, updated_at)
         VALUES (@id, @key, @kind, @status, @subject, @source_section_id, @target_section_id, @new_name,
           @thread_ids, @evidence_count, @entry_id, @acknowledged, @created_at, @updated_at)`,
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
      .prepare("UPDATE ws_proposal SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.now(), row.id);
  }

  private snooze(row: Row) {
    this.deps.db
      .prepare(
        `INSERT INTO ws_snooze (key, evidence_count, at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET evidence_count = excluded.evidence_count, at = excluded.at`,
      )
      .run(row.key, row.evidence_count, this.now());
  }

  private nameOf(sectionId: string | null): string {
    if (!sectionId) return "Unsorted";
    return this.deps.map.get(sectionId)?.name ?? "a deleted workstream";
  }

  private rationale(row: Row, prefix: string): string {
    const n = (JSON.parse(row.thread_ids) as string[]).length;
    const threads = `${n} thread${n === 1 ? "" : "s"}`;
    const source = this.nameOf(row.source_section_id || null);
    if (row.kind === "spin-out")
      return `${prefix}Spun out ${row.new_name} from ${source} (${threads} share the subject)`;
    const target = this.nameOf(row.target_section_id);
    if (row.kind === "merge")
      return `${prefix}Merged ${source} into ${target} (${threads})`;
    return `${prefix}Moved ${threads} from ${source} to ${target} (subject ${row.subject})`;
  }

  private threadRefs(ids: readonly string[]) {
    const titles = new Map(
      this.deps.service.threads().map((t) => [t.id, t.title]),
    );
    return ids.map((id) => ({ id, name: titles.get(id) ?? id }));
  }

  private workstreamRefs(row: Row) {
    return [row.source_section_id || null, row.target_section_id]
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id, name: this.nameOf(id) }));
  }

  private view(row: Row): ProposalView {
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
    };
  }
}
