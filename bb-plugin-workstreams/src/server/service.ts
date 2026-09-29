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
} from "./inventory.ts";
import type { JournalEntry, Journal, Source } from "./journal.ts";

type Sdk = BbPluginApi["sdk"];

export type Placement = {
  sectionId: string | null;
  source: Source;
  at: number;
  entryId: string | null;
};

export type WorkstreamRecord = {
  description: string | null;
  descriptionSource: "generated" | "user";
  createdBy: "user" | "workstreams";
};

export class UserError extends Error {}

const NAME_MAX = 80;

export class WorkstreamService {
  private queue: Promise<unknown> = Promise.resolve();
  private lastReconciledAt: number | null = null;

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

  state(): {
    workstreams: Record<string, WorkstreamRecord>;
    placements: Record<string, Placement>;
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
    const placements: Record<string, Placement> = {};
    for (const row of this.db
      .prepare(
        "SELECT thread_id, section_id, source, entry_id, at FROM ws_placement",
      )
      .all() as {
      thread_id: string;
      section_id: string | null;
      source: Source;
      entry_id: string | null;
      at: number;
    }[])
      placements[row.thread_id] = {
        sectionId: row.section_id,
        source: row.source,
        at: row.at,
        entryId: row.entry_id,
      };
    return { workstreams, placements, lastReconciledAt: this.lastReconciledAt };
  }

  /** Files a root thread (and so its whole tree) under a workstream. */
  move(
    threadId: string,
    sectionId: string | null,
    source: Source,
  ): Promise<JournalEntry | null> {
    return this.serial(async () => {
      const sdk = this.sdk();
      const thread = await sdk.threads.get({ threadId });
      if (thread.archivedAt !== null)
        throw new UserError("Archived threads can't be moved.");
      if (
        thread.parentThreadId &&
        (await this.isVisibleActive(thread.parentThreadId))
      )
        throw new UserError(
          "This thread follows its parent's workstream. Move the parent instead.",
        );
      const sections = await listSections(sdk);
      const names = new Map(sections.map((s) => [s.id, s.name]));
      if (sectionId !== null && !names.has(sectionId))
        throw new UserError("That workstream no longer exists.");
      const from = thread.sectionId ?? null;
      if (from === sectionId) return null;
      await sdk.threads.update({ threadId, sectionId });
      const title = displayTitle(thread);
      const fromName = from
        ? (names.get(from) ?? "a deleted workstream")
        : "Unsorted";
      const toName = sectionId ? names.get(sectionId)! : "Unsorted";
      const entry = this.journal.add({
        action: "move",
        source,
        rationale: `Moved from ${fromName} to ${toName}`,
        threads: [{ id: threadId, name: title }],
        workstreams: [
          ...(from ? [{ id: from, name: fromName }] : []),
          ...(sectionId ? [{ id: sectionId, name: toName }] : []),
        ],
        undo: { kind: "move", moves: [{ threadId, from, to: sectionId }] },
      });
      this.place(threadId, sectionId, source, entry.id);
      this.seeThread(threadId, sectionId, thread.parentThreadId ?? null);
      this.onChange();
      return entry;
    });
  }

  createWorkstream(
    name: string,
    source: Source,
  ): Promise<{ sectionId: string; entry: JournalEntry }> {
    return this.serial(async () => {
      const clean = normalizeName(name);
      const sdk = this.sdk();
      const sections = await listSections(sdk);
      if (sections.some((s) => s.name.toLowerCase() === clean.toLowerCase()))
        throw new UserError(`A workstream named "${clean}" already exists.`);
      const created = await sdk.threadSections.create({ name: clean });
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO ws_workstream (section_id, description, description_source, created_by, created_at, updated_at)
           VALUES (?, NULL, 'generated', 'workstreams', ?, ?)
           ON CONFLICT(section_id) DO NOTHING`,
        )
        .run(created.id, at, at);
      this.seeSection(created.id, created.name);
      const entry = this.journal.add({
        action: "create-workstream",
        source,
        rationale: `Created ${created.name}`,
        threads: [],
        workstreams: [{ id: created.id, name: created.name }],
        undo: { kind: "delete-section", sectionId: created.id },
      });
      this.onChange();
      return { sectionId: created.id, entry };
    });
  }

  renameWorkstream(
    sectionId: string,
    name: string,
    source: Source,
  ): Promise<JournalEntry | null> {
    return this.serial(async () => {
      const clean = normalizeName(name);
      const sdk = this.sdk();
      const sections = await listSections(sdk);
      const current = sections.find((s) => s.id === sectionId);
      if (!current) throw new UserError("That workstream no longer exists.");
      if (current.name === clean) return null;
      if (
        sections.some(
          (s) =>
            s.id !== sectionId && s.name.toLowerCase() === clean.toLowerCase(),
        )
      )
        throw new UserError(`A workstream named "${clean}" already exists.`);
      await sdk.threadSections.update({ id: sectionId, name: clean });
      this.seeSection(sectionId, clean);
      const entry = this.journal.add({
        action: "rename-workstream",
        source,
        rationale: `Renamed ${current.name} to ${clean}`,
        threads: [],
        workstreams: [{ id: sectionId, name: clean }],
        undo: {
          kind: "rename-section",
          sectionId,
          from: current.name,
          to: clean,
        },
      });
      this.onChange();
      return entry;
    });
  }

  /**
   * Reverses a journaled change where BB state still matches what the change
   * left behind. Parts that were changed again since are skipped and reported.
   */
  undo(entryId: string): Promise<JournalEntry> {
    return this.serial(async () => {
      const original = this.journal.get(entryId);
      if (!original)
        throw new UserError("That change is no longer in the log.");
      if (original.status === "undone") throw new UserError("Already undone.");
      if (!original.undo) throw new UserError("This change can't be undone.");
      const sdk = this.sdk();
      const plan = original.undo;
      let skipped = 0;
      let done = 0;
      if (plan.kind === "move") {
        for (const move of plan.moves) {
          const thread = await sdk.threads.get({ threadId: move.threadId });
          if (
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
          this.place(move.threadId, move.from, "user", null);
          this.seeThread(
            move.threadId,
            move.from,
            thread.parentThreadId ?? null,
          );
          done++;
        }
      } else if (plan.kind === "delete-section") {
        if (!(await sectionIsEmpty(sdk, plan.sectionId)))
          throw new UserError(
            "The workstream still has threads (including archived ones). Move them first.",
          );
        await sdk.threadSections.delete({ id: plan.sectionId });
        this.db
          .prepare("DELETE FROM ws_workstream WHERE section_id = ?")
          .run(plan.sectionId);
        this.db
          .prepare("DELETE FROM ws_seen_section WHERE section_id = ?")
          .run(plan.sectionId);
        done++;
      } else {
        const sections = await listSections(sdk);
        const current = sections.find((s) => s.id === plan.sectionId);
        if (!current || current.name !== plan.to) skipped++;
        else {
          await sdk.threadSections.update({
            id: plan.sectionId,
            name: plan.from,
          });
          this.seeSection(plan.sectionId, plan.from);
          done++;
        }
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
                "SELECT thread_id, section_id, parent_thread_id FROM ws_seen_thread",
              )
              .all() as {
              thread_id: string;
              section_id: string | null;
              parent_thread_id: string | null;
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
              : "Unsorted";
            const toName = to ? (names.get(to) ?? "a workstream") : "Unsorted";
            const entry = this.journal.add({
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
            this.place(thread.id, to, "external", entry.id);
            changed = true;
          }
          if (
            !before ||
            before.section_id !== thread.sectionId ||
            before.parent_thread_id !== (thread.parentThreadId ?? null)
          )
            this.seeThread(
              thread.id,
              thread.sectionId,
              thread.parentThreadId ?? null,
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
      if (changed) this.onChange();
      return changed;
    });
  }

  private async isVisibleActive(threadId: string): Promise<boolean> {
    try {
      const parent = await this.sdk().threads.get({ threadId });
      return parent.archivedAt === null && parent.visibility !== "hidden";
    } catch {
      return false;
    }
  }

  private place(
    threadId: string,
    sectionId: string | null,
    source: Source,
    entryId: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO ws_placement (thread_id, section_id, source, entry_id, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET section_id = excluded.section_id, source = excluded.source,
           entry_id = excluded.entry_id, at = excluded.at`,
      )
      .run(threadId, sectionId, source, entryId, this.now());
  }

  private seeThread(
    threadId: string,
    sectionId: string | null,
    parentThreadId: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO ws_seen_thread (thread_id, section_id, parent_thread_id) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET section_id = excluded.section_id, parent_thread_id = excluded.parent_thread_id`,
      )
      .run(threadId, sectionId, parentThreadId);
  }

  private seeSection(sectionId: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO ws_seen_section (section_id, name) VALUES (?, ?)
         ON CONFLICT(section_id) DO UPDATE SET name = excluded.name`,
      )
      .run(sectionId, name);
  }
}

function normalizeName(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) throw new UserError("A workstream needs a name.");
  if (clean.length > NAME_MAX)
    throw new UserError(`Keep workstream names under ${NAME_MAX} characters.`);
  return clean;
}
