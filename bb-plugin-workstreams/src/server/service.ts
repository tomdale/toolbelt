/**
 * Workstream state and every mutation Workstreams performs.
 *
 * A workstream is a native BB section plus a record in `ws_workstream`. All
 * mutations and the reconciler run through one serial queue and write through
 * to the reconciler's last-seen snapshot, so the reconciler never mistakes a
 * Workstreams change for one made elsewhere.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Database } from "./db.ts";
import { getMeta, setMeta } from "./db.ts";
import { buildForest } from "../domain/tree.ts";
import {
  displayTitle,
  listActiveThreads,
  listSections,
  sectionIsEmpty,
  type InventoryThread,
} from "./inventory.ts";
import type { JournalEntry, Journal, Source, UndoStep } from "./journal.ts";
import { retitleDecision, type RetitleBasis } from "../domain/titles.ts";
import { forgetTitle, observeThreadTitle, writeTitleRecord } from "./titles.ts";

type Sdk = BbPluginApi["sdk"];

export type WorkstreamRecord = {
  description: string | null;
  descriptionSource: "generated" | "user";
  createdBy: "user" | "workstreams";
};

export class UserError extends Error {}

export class WorkstreamService {
  private queue: Promise<unknown> = Promise.resolve();
  private lastReconciledAt: number | null = null;
  private lastThreads: InventoryThread[] = [];

  constructor(
    private readonly sdk: () => Sdk,
    private readonly db: Database,
    private readonly journal: Journal,
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs `task` after every earlier mutation or reconcile has settled. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Runs `task` in the mutation queue, after every earlier mutation or
   * reconcile has settled and before any later one starts. The organizer
   * applies its section changes through this so they never interleave with a
   * move, a retitle, or a reconcile. `task` must not call another queued
   * method, which would wait on itself.
   */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.serial(task);
  }

  state(): {
    workstreams: Record<string, WorkstreamRecord>;
    lastReconciledAt: number | null;
  } {
    const workstreams: Record<string, WorkstreamRecord> = {};
    for (const row of this.db
      .prepare(
        "SELECT section_id, description, description_source, created_by FROM ws_workstream",
      )
      .all() as {
      section_id: string;
      description: string | null;
      description_source: WorkstreamRecord["descriptionSource"];
      created_by: WorkstreamRecord["createdBy"];
    }[])
      workstreams[row.section_id] = {
        description: row.description,
        descriptionSource: row.description_source,
        createdBy: row.created_by,
      };
    return { workstreams, lastReconciledAt: this.lastReconciledAt };
  }

  /**
   * Applies a title that Workstreams inferred as the thread's goal, under the
   * retitle policy (SPEC §10.1). `revision` is the thread revision the goal
   * was inferred for, and `basis` says from what: a finished turn's analysis,
   * or the opening request alone while the first turn runs. When the policy
   * declines, nothing changes and `skipped` says why. `rationale` replaces
   * the journal entry's usual explanation when the caller knows a better one.
   */
  retitle(
    threadId: string,
    suggestion: string | null,
    revision: number,
    basis: RetitleBasis = "analysis",
    rationale?: string,
  ): Promise<{ entry: JournalEntry | null; skipped: string | null }> {
    return this.serial(async () => {
      const sdk = this.sdk();
      const thread = await sdk.threads.get({ threadId }).catch(() => null);
      if (
        !thread ||
        thread.archivedAt !== null ||
        thread.visibility === "hidden"
      )
        return { entry: null, skipped: "archived-or-hidden" };
      const record = observeThreadTitle(this.db, threadId, thread.title);
      const from = displayTitle(thread);
      const decision = retitleDecision({
        record,
        thread: {
          title: thread.title,
          displayTitle: from,
          status: thread.status,
          latestAttentionAt: thread.latestAttentionAt ?? thread.updatedAt,
        },
        suggestion,
        revision,
        basis,
        now: this.now(),
      });
      if (!decision.ok || !suggestion) {
        // The analysis of the first finished turn settles a provisional title
        // even when it keeps it; any later change is an ordinary retitle.
        if (
          !decision.ok &&
          decision.reason === "unchanged" &&
          basis === "analysis" &&
          record.provisional &&
          thread.status === "idle" &&
          (thread.latestAttentionAt ?? thread.updatedAt) <= revision
        )
          writeTitleRecord(this.db, threadId, {
            ...record,
            provisional: false,
          });
        return {
          entry: null,
          skipped: decision.ok ? "no-suggestion" : decision.reason,
        };
      }
      await sdk.threads.update({ threadId, title: suggestion });
      writeTitleRecord(this.db, threadId, {
        observed: suggestion,
        written: suggestion,
        locked: false,
        retitledAt: this.now(),
        provisional: basis === "opening",
      });
      this.seeThread(
        threadId,
        thread.sectionId ?? null,
        thread.parentThreadId ?? null,
        suggestion,
      );
      const entry = this.journal.add({
        action: "retitle",
        source: "auto",
        rationale:
          rationale ??
          (basis === "opening"
            ? "Titled from the opening request"
            : record.provisional
              ? `Retitled after the first turn from ${from}`
              : thread.title
                ? `Retitled from ${from}`
                : "Titled an untitled thread"),
        threads: [{ id: threadId, name: suggestion }],
        workstreams: [],
        undo: { kind: "retitle", threadId, from: thread.title, to: suggestion },
      });
      this.onChange();
      return { entry, skipped: null };
    });
  }

  /**
   * Reverses a journaled change where BB state still matches what the change
   * left behind. Parts that were changed again since are skipped and reported.
   * A batch is undone as a whole, in reverse order.
   */
  undo(entryId: string): Promise<JournalEntry> {
    return this.serial(async () => {
      const original = this.journal.get(entryId);
      if (!original)
        throw new UserError("That change is no longer in the log.");
      if (original.status === "undone") throw new UserError("Already undone.");
      if (!original.undo) throw new UserError("This change can't be undone.");
      const steps =
        original.undo.kind === "batch"
          ? [...original.undo.steps].reverse()
          : [original.undo];
      let skipped = 0;
      let done = 0;
      const restored = new Map<string, string>();
      for (const step of steps) {
        const result = await this.undoStep(step, restored);
        done += result.done;
        skipped += result.skipped;
      }
      if (done === 0)
        throw new UserError("Nothing to undo: everything changed again since.");
      const entry = this.journal.add({
        action: "undo",
        source: "user",
        status: skipped > 0 ? "partial" : "applied",
        rationale: `Undid: ${original.rationale}`,
        threads: original.threads,
        workstreams: original.workstreams,
        undo: null,
        undoes: original.id,
        detail:
          skipped > 0
            ? `${skipped} part(s) had changed again and were left alone.`
            : null,
      });
      this.journal.markUndone(original.id, entry.id);
      this.onChange();
      return entry;
    });
  }

  /** Reverts one step; returns how many parts were reverted and skipped. */
  private async undoStep(
    step: UndoStep,
    restored = new Map<string, string>(),
  ): Promise<{ done: number; skipped: number }> {
    const sdk = this.sdk();
    if (step.kind === "restore-section") {
      const sections = await listSections(sdk);
      // Reuse only a section this Undo previously recreated, never a namesake.
      const restoreKey = `restore-section:${step.sectionId}`;
      const previousId = getMeta(this.db, restoreKey);
      let section = previousId
        ? sections.find((s) => s.id === previousId)
        : undefined;
      if (!section) {
        if (
          sections.some((s) => s.name.toLowerCase() === step.name.toLowerCase())
        )
          return { done: 0, skipped: 1 + step.archivedThreads.length };
        section = await sdk.threadSections.create({ name: step.name });
        setMeta(this.db, restoreKey, section.id);
        this.db
          .prepare(
            "INSERT INTO ws_workstream(section_id,description,description_source,created_by,created_at,updated_at,aliases) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            section.id,
            step.metadata.description,
            step.metadata.source,
            step.metadata.createdBy,
            this.now(),
            this.now(),
            JSON.stringify(step.metadata.aliases),
          );
        this.seeSection(section.id, section.name);
      }
      restored.set(step.sectionId, section.id);
      let done = 1,
        skipped = 0;
      for (const member of step.archivedThreads) {
        const thread = await sdk.threads
          .get({ threadId: member.id })
          .catch(() => null);
        if (
          !thread ||
          thread.sectionId !== null ||
          thread.archivedAt !== member.archivedAt
        ) {
          skipped++;
          continue;
        }
        await sdk.threads.update({
          threadId: member.id,
          sectionId: section.id,
        });
        done++;
      }
      return { done, skipped };
    }
    if (step.kind === "move") {
      let done = 0;
      let skipped = 0;
      for (const originalMove of step.moves) {
        const move = {
          ...originalMove,
          from: originalMove.from
            ? (restored.get(originalMove.from) ?? originalMove.from)
            : null,
          to: originalMove.to
            ? (restored.get(originalMove.to) ?? originalMove.to)
            : null,
        };
        if (
          move.from &&
          !(await listSections(sdk)).some((s) => s.id === move.from)
        ) {
          skipped++;
          continue;
        }
        const thread = await sdk.threads
          .get({ threadId: move.threadId })
          .catch(() => null);
        if (
          !thread ||
          (thread.sectionId ?? null) !== move.to ||
          thread.archivedAt !== null
        ) {
          skipped++;
          continue;
        }
        await sdk.threads.update({
          threadId: move.threadId,
          sectionId: move.from,
        });
        // Record Undo as the user's placement decision.
        this.seeThread(move.threadId, move.from, thread.parentThreadId ?? null);
        done++;
      }
      return { done, skipped };
    }
    if (step.kind === "retitle") {
      const thread = await sdk.threads
        .get({ threadId: step.threadId })
        .catch(() => null);
      if (!thread || thread.title !== step.to) return { done: 0, skipped: 1 };
      await sdk.threads.update({ threadId: step.threadId, title: step.from });
      // Undoing is the user's decision: the title they went back to stays.
      writeTitleRecord(this.db, step.threadId, {
        observed: step.from,
        written: null,
        locked: true,
        retitledAt: null,
        provisional: false,
      });
      this.seeThread(
        step.threadId,
        thread.sectionId ?? null,
        thread.parentThreadId ?? null,
        step.from ?? thread.titleFallback ?? undefined,
      );
      return { done: 1, skipped: 0 };
    }
    if (step.kind === "delete-section") {
      if (!(await sectionIsEmpty(sdk, step.sectionId))) {
        if (!step.inBatch)
          throw new UserError(
            "The workstream still has threads (including archived ones). Move them first.",
          );
        return { done: 0, skipped: 1 };
      }
      await sdk.threadSections.delete({ id: step.sectionId });
      this.db
        .prepare("DELETE FROM ws_workstream WHERE section_id = ?")
        .run(step.sectionId);
      this.db
        .prepare("DELETE FROM ws_seen_section WHERE section_id = ?")
        .run(step.sectionId);
      return { done: 1, skipped: 0 };
    }
    if (step.kind === "metadata") {
      const row = this.db
        .prepare(
          "SELECT description, aliases, description_source, metadata_revision FROM ws_workstream WHERE section_id = ?",
        )
        .get(step.sectionId) as
        | {
            description: string | null;
            aliases: string;
            description_source: string;
            metadata_revision: number;
          }
        | undefined;
      if (
        !row ||
        row.description !== step.to.description ||
        row.aliases !== JSON.stringify(step.to.aliases) ||
        row.description_source !== step.to.source ||
        row.metadata_revision !== step.to.revision
      )
        return { done: 0, skipped: 1 };
      this.db
        .prepare(
          "UPDATE ws_workstream SET description = ?, aliases = ?, description_source = ?, metadata_revision = metadata_revision + 1, updated_at = ? WHERE section_id = ?",
        )
        .run(
          step.from.description,
          JSON.stringify(step.from.aliases),
          step.from.source,
          this.now(),
          step.sectionId,
        );
      return { done: 1, skipped: 0 };
    }
    const sections = await listSections(sdk);
    const current = sections.find((s) => s.id === step.sectionId);
    if (!current || current.name !== step.to) return { done: 0, skipped: 1 };
    await sdk.threadSections.update({ id: step.sectionId, name: step.from });
    this.seeSection(step.sectionId, step.from);
    return { done: 1, skipped: 0 };
  }

  /**
   * Journals a thread started from the New thread composer or a Debug
   * report. The organizer files it by its topic.
   */
  recordCreated(
    threadId: string,
    sectionId: string | null,
    source: Source,
    details: { title: string; rationale: string },
  ): JournalEntry {
    const name = sectionId
      ? (this.db
          .prepare("SELECT name FROM ws_seen_section WHERE section_id = ?")
          .get(sectionId) as { name: string } | undefined)
      : undefined;
    const entry = this.journal.add({
      action: "route",
      source,
      rationale: details.rationale,
      threads: [{ id: threadId, name: details.title }],
      workstreams: sectionId ? [{ id: sectionId, name: name?.name ?? "" }] : [],
      undo: sectionId
        ? { kind: "move", moves: [{ threadId, from: null, to: sectionId }] }
        : null,
    });
    if (sectionId) {
      this.seeThread(threadId, sectionId, null);
    } else this.seeThread(threadId, null, null);
    this.onChange();
    return entry;
  }

  /**
   * Diffs BB's live state against the last-seen snapshot. BB emits no events
   * for section moves or section edits (SPEC §3), so this is how Workstreams
   * learns about changes made in the built-in sidebar, the CLI, or by agents.
   * The first run only records a baseline.
   */
  reconcile(): Promise<boolean> {
    return this.serial(async () => {
      const sdk = this.sdk();
      const [threads, sections] = await Promise.all([
        listActiveThreads(sdk),
        listSections(sdk),
      ]);
      const seeded = getMeta(this.db, "seeded") === "1";
      let changed = false;
      const seenSections = new Map(
        (
          this.db
            .prepare("SELECT section_id, name FROM ws_seen_section")
            .all() as {
            section_id: string;
            name: string;
          }[]
        ).map((r) => [r.section_id, r.name]),
      );
      const names = new Map(sections.map((s) => [s.id, s.name]));
      const at = this.now();
      const tx = this.db.transaction(() => {
        for (const section of sections) {
          const before = seenSections.get(section.id);
          if (before === undefined) {
            this.db
              .prepare(
                `INSERT INTO ws_workstream (section_id, description, description_source, created_by, created_at, updated_at)
                 VALUES (?, NULL, 'generated', 'user', ?, ?) ON CONFLICT(section_id) DO NOTHING`,
              )
              .run(section.id, at, at);
            if (seeded) {
              this.journal.add({
                action: "create-workstream",
                source: "external",
                rationale: `Created ${section.name} outside Workstreams`,
                threads: [],
                workstreams: [{ id: section.id, name: section.name }],
                undo: null,
              });
              changed = true;
            }
            this.seeSection(section.id, section.name);
          } else if (before !== section.name) {
            if (seeded) {
              this.journal.add({
                action: "rename-workstream",
                source: "external",
                rationale: `Renamed ${before} to ${section.name} outside Workstreams`,
                threads: [],
                workstreams: [{ id: section.id, name: section.name }],
                undo: null,
              });
              changed = true;
            }
            this.seeSection(section.id, section.name);
          }
        }
        for (const [id, name] of seenSections) {
          if (names.has(id)) continue;
          if (seeded) {
            this.journal.add({
              action: "delete-workstream",
              source: "external",
              rationale: `Deleted ${name} outside Workstreams`,
              threads: [],
              workstreams: [{ id, name }],
              undo: null,
            });
            changed = true;
          }
          this.db
            .prepare("DELETE FROM ws_seen_section WHERE section_id = ?")
            .run(id);
          this.db
            .prepare("DELETE FROM ws_workstream WHERE section_id = ?")
            .run(id);
        }

        const seen = new Map(
          (
            this.db
              .prepare(
                "SELECT thread_id, section_id, parent_thread_id, title FROM ws_seen_thread",
              )
              .all() as {
              thread_id: string;
              section_id: string | null;
              parent_thread_id: string | null;
              title: string | null;
            }[]
          ).map((r) => [r.thread_id, r]),
        );
        // Only a root's section decides grouping (SPEC I2), so only root moves
        // are worth recording.
        const forest = buildForest(threads);
        const isRoot = new Set(forest.roots.map((r) => r.thread.id));
        for (const thread of threads) {
          const before = seen.get(thread.id);
          if (
            before &&
            seeded &&
            isRoot.has(thread.id) &&
            before.section_id !== thread.sectionId
          ) {
            const from = before.section_id;
            const to = thread.sectionId;
            const fromName = from
              ? (names.get(from) ??
                seenSections.get(from) ??
                "a deleted workstream")
              : "Unfiled";
            const toName = to ? (names.get(to) ?? "a workstream") : "Unfiled";
            this.journal.add({
              action: "move",
              source: "external",
              rationale: `Moved from ${fromName} to ${toName} outside Workstreams`,
              threads: [{ id: thread.id, name: thread.title }],
              workstreams: [
                ...(from ? [{ id: from, name: fromName }] : []),
                ...(to ? [{ id: to, name: toName }] : []),
              ],
              undo: {
                kind: "move",
                moves: [{ threadId: thread.id, from, to }],
              },
            });
            changed = true;
          }
          observeThreadTitle(this.db, thread.id, thread.ownTitle);
          if (
            !before ||
            before.section_id !== thread.sectionId ||
            before.parent_thread_id !== (thread.parentThreadId ?? null) ||
            before.title !== thread.title
          )
            this.seeThread(
              thread.id,
              thread.sectionId,
              thread.parentThreadId ?? null,
              thread.title,
            );
        }
        const present = new Set(threads.map((t) => t.id));
        for (const id of seen.keys())
          if (!present.has(id))
            this.db
              .prepare("DELETE FROM ws_seen_thread WHERE thread_id = ?")
              .run(id);
        if (!seeded) setMeta(this.db, "seeded", "1");
      });
      tx();
      this.lastReconciledAt = at;
      this.lastThreads = threads;
      if (changed) this.onChange();
      return changed;
    });
  }

  /** Visible, non-archived threads as of the last reconcile. */
  threads(): readonly InventoryThread[] {
    return this.lastThreads;
  }

  /** Drops per-thread records once BB has deleted the thread. */
  forget(threadId: string): void {
    this.db
      .prepare("DELETE FROM ws_seen_thread WHERE thread_id = ?")
      .run(threadId);
    forgetTitle(this.db, threadId);
  }

  /**
   * The reconciler's snapshot of a visible, non-archived thread. It also
   * backs `configure`, which must answer synchronously (SPEC §5).
   */
  seeThread(
    threadId: string,
    sectionId: string | null,
    parentThreadId: string | null,
    title?: string,
    /** Seed only: never overwrite what the reconciler or a move recorded. */
    onlyIfNew = false,
  ): void {
    if (onlyIfNew) {
      this.db
        .prepare(
          `INSERT INTO ws_seen_thread (thread_id, section_id, parent_thread_id, title) VALUES (?, ?, ?, ?)
           ON CONFLICT(thread_id) DO NOTHING`,
        )
        .run(threadId, sectionId, parentThreadId, title ?? null);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO ws_seen_thread (thread_id, section_id, parent_thread_id, title) VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET section_id = excluded.section_id, parent_thread_id = excluded.parent_thread_id,
           title = COALESCE(excluded.title, ws_seen_thread.title)`,
      )
      .run(threadId, sectionId, parentThreadId, title ?? null);
  }

  seeSection(sectionId: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO ws_seen_section (section_id, name) VALUES (?, ?)
         ON CONFLICT(section_id) DO UPDATE SET name = excluded.name`,
      )
      .run(sectionId, name);
  }
}
