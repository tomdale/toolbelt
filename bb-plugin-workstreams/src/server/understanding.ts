import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { redact } from "../domain/analysis.ts";
import {
  MAX_ENTRY_CHARS,
  MAX_PROMPT_CHARS,
  observationId,
  synthesisPrompt,
  termsOf,
  type Account,
  type Observation,
} from "../domain/understanding.ts";
import { randomUUID } from "node:crypto";
import {
  debugOverviewSchema,
  accountDetailSchema,
  observationDetailSchema,
  retrievalReportSchema,
  retrievalSnapshotSchema,
  type AccountDetail,
  type Belief,
  type DebugOverview,
  type Evidence,
  type ObservationDetail,
  type RetrievalReport,
  type RetrievalSnapshot,
  type Revision,
} from "../domain/understanding-debug.ts";
import type { Database } from "./db.ts";
import { traceIdOf, type Inference } from "./model.ts";

type Sdk = BbPluginApi["sdk"];
type Entry = {
  id: string;
  speaker: "user" | "assistant";
  text: string;
  at: number | null;
  seq: number;
};
type Progress = {
  threadId: string;
  cursor: string | null;
  status: string;
  error: string | null;
  updatedAt: number;
  dirty: number;
  completedRevision: number | null;
  backlog: number;
};
type ObservationRow = Omit<Observation, "terms"> & {
  terms: string;
  traceId: string | null;
};
type AccountRow = Omit<Account, "questions" | "evidenceIds"> & {
  questions: string;
  evidenceIds: string;
  traceId: string | null;
};
type SnapshotRow = {
  id: string;
  at: number;
  consumer: "analysis" | "route";
  thread_id: string | null;
  trace_id: string | null;
  report: string;
};
const OBS_COLUMNS =
  "id,thread_id AS threadId,entry_id AS entryId,speaker,quote,observation,epistemic,source_at AS sourceAt,terms,trace_id AS traceId";
const ACCOUNT_COLUMNS =
  "id,name,narrative,questions,evidence_ids AS evidenceIds,updated_at AS updatedAt,trace_id AS traceId";
const PROGRESS_COLUMNS =
  "thread_id AS threadId,cursor,status,error,updated_at AS updatedAt,dirty,completed_revision AS completedRevision,backlog";
const RETRY_MS = 10 * 60_000;
const CHUNK = 8;
const CHUNKS_PER_PASS = 3;
const decodeObservation = (row: ObservationRow): Observation => ({
  ...row,
  terms: JSON.parse(row.terms),
});
const decodeAccount = (
  row: AccountRow,
): Account & { traceId: string | null } => ({
  ...row,
  questions: JSON.parse(row.questions),
  evidenceIds: JSON.parse(row.evidenceIds),
});
const belief = (account: Account & { traceId?: string | null }): Belief => ({
  id: account.id,
  name: account.name,
  narrative: account.narrative,
  questions: account.questions,
  evidenceIds: account.evidenceIds,
  updatedAt: account.updatedAt,
  traceId: account.traceId ?? null,
});
const evidence = (o: Observation & { traceId?: string | null }): Evidence => ({
  id: o.id,
  threadId: o.threadId,
  entryId: o.entryId,
  speaker: o.speaker,
  quote: o.quote,
  observation: o.observation,
  epistemic: o.epistemic,
  terms: o.terms,
  sourceAt: o.sourceAt,
  traceId: o.traceId ?? null,
});

/**
 * Evidence collection and reconciliation share one serial queue. This bounds
 * background model use and gives each synthesis a consistent evidence snapshot.
 * Deletion can interrupt the queue, so every async write also checks generation.
 */
export class Understanding {
  private disposed = false;
  private readonly deleted = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private controller: AbortController | null = null;
  private generation = 0;
  private forgetGeneration = 0;

  constructor(
    private readonly deps: {
      sdk: () => Sdk;
      db: Database;
      inference: Inference;
      model: () => Promise<string>;
      onChange: () => void;
      log: (message: string) => void;
      now?: () => number;
    },
  ) {}
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private revisionAt(accountId: string): number {
    const row = this.deps.db
      .prepare(
        "SELECT max(at) AS at FROM ws_understanding_revision WHERE account_id=?",
      )
      .get(accountId) as { at: number | null } | undefined;
    return Math.max(this.now(), (row?.at ?? -1) + 1);
  }
  private alive(threadId: string) {
    return !this.disposed && !this.deleted.has(threadId);
  }
  private progress(threadId: string): Progress | undefined {
    return this.deps.db
      .prepare(
        `SELECT ${PROGRESS_COLUMNS} FROM ws_understanding_progress WHERE thread_id = ?`,
      )
      .get(threadId) as Progress | undefined;
  }
  private saveProgress(p: Progress) {
    if (!this.alive(p.threadId)) return;
    this.deps.db
      .prepare(
        `INSERT INTO ws_understanding_progress
      (thread_id,cursor,status,error,updated_at,dirty,completed_revision,backlog) VALUES (@threadId,@cursor,@status,@error,@updatedAt,@dirty,@completedRevision,@backlog)
      ON CONFLICT(thread_id) DO UPDATE SET cursor=excluded.cursor,status=excluded.status,error=excluded.error,
      updated_at=excluded.updated_at,dirty=excluded.dirty,completed_revision=excluded.completed_revision,backlog=excluded.backlog`,
      )
      .run(p);
  }
  needsObservation(threadId: string, revision: number): boolean {
    if (!this.alive(threadId) || this.running.has(threadId)) return false;
    const p = this.progress(threadId);
    if (!p) return true;
    if (p.status === "failed" && this.now() - p.updatedAt < RETRY_MS)
      return false;
    return p.dirty !== 0 || p.backlog !== 0 || p.completedRevision !== revision;
  }
  observe(threadId: string): Promise<void> {
    if (!this.alive(threadId)) return Promise.resolve();
    const existing = this.running.get(threadId);
    if (existing) return existing;
    const work = this.queue.then(() => this.run(threadId));
    this.queue = work.catch(() => undefined);
    const settled = work.finally(() => {
      if (this.running.get(threadId) === settled) this.running.delete(threadId);
    });
    this.running.set(threadId, settled);
    return settled;
  }
  private async run(threadId: string): Promise<void> {
    if (!this.alive(threadId)) return;
    const controller = new AbortController();
    this.controller = controller;
    let p: Progress = this.progress(threadId) ?? {
      threadId,
      cursor: null,
      status: "pending",
      error: null,
      updatedAt: this.now(),
      dirty: 0,
      completedRevision: null,
      backlog: 0,
    };
    try {
      const thread = await this.deps
        .sdk()
        .threads.get({ threadId, signal: controller.signal });
      if (
        !this.alive(threadId) ||
        thread.status !== "idle" ||
        thread.visibility === "hidden" ||
        thread.archivedAt !== null
      )
        return;
      const revision = thread.latestAttentionAt ?? thread.updatedAt;
      if (p.completedRevision === revision && !p.backlog && !p.dirty) return;
      const entries = await this.readEntries(threadId, controller.signal);
      if (!this.alive(threadId)) return;
      const cursorIndex =
        p.cursor === null ? -1 : entries.findIndex((e) => e.id === p.cursor);
      if (p.cursor !== null && cursorIndex < 0)
        throw new Error(
          "Evidence cursor is absent from this transcript; explicit reindexing is required.",
        );
      let next = cursorIndex + 1;
      const end = Math.min(entries.length, next + CHUNK * CHUNKS_PER_PASS);
      p = {
        ...p,
        status: "pending",
        error: null,
        backlog: entries.length - next,
        updatedAt: this.now(),
      };
      this.saveProgress(p);
      while (next < end) {
        const chunk = entries.slice(next, Math.min(next + CHUNK, end));
        const input = {
          entries: chunk.map(({ id, speaker, text, at }) => ({
            id,
            speaker,
            text,
            at,
          })),
        };
        const extractionForgetGeneration = this.forgetGeneration;
        let traceId: string | null = null;
        let value: Observation[];
        try {
          const result = await this.deps.inference.run(
            "understanding-extract",
            input,
            {
              model: await this.deps.model(),
              signal: controller.signal,
              label: `Evidence ${threadId}`,
              links: [{ kind: "thread", ref: threadId }],
            },
          );
          value = result.value as Observation[];
          traceId = result.traceId;
        } catch (error) {
          const failedTraceId = traceIdOf(error);
          const retained = this.alive(threadId);
          this.deps.inference.annotate(failedTraceId, {
            outcome: retained ? "failed" : "discarded",
            reason: retained
              ? redact(
                  error instanceof Error ? error.message : String(error),
                ).slice(0, 300)
              : "source was deleted or service disposed",
          });
          if (extractionForgetGeneration !== this.forgetGeneration)
            this.deps.inference.forgetTraces([failedTraceId]);
          throw error;
        }
        if (!this.alive(threadId)) {
          this.deps.inference.annotate(traceId, {
            outcome: "discarded",
            reason: "source was deleted or service disposed",
          });
          if (this.deleted.has(threadId))
            this.deps.inference.forgetTraces([traceId]);
          return;
        }
        let inserted = 0;
        let changed = false;
        const commit = this.deps.db.transaction(() => {
          for (const observation of value) {
            const source = chunk.find((e) => e.id === observation.entryId)!;
            const result = this.deps.db
              .prepare(
                `INSERT OR IGNORE INTO ws_understanding_observation
              (id,thread_id,entry_id,speaker,quote,observation,epistemic,created_at,source_at,terms,trace_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                observationId(
                  threadId,
                  observation.entryId,
                  observation.observation,
                ),
                threadId,
                observation.entryId,
                observation.speaker,
                observation.quote,
                observation.observation,
                observation.epistemic,
                this.now(),
                source.at,
                JSON.stringify(observation.terms),
                traceId,
              );
            changed ||= result.changes > 0;
            inserted += result.changes;
          }
          next += chunk.length;
          p = {
            ...p,
            cursor: chunk.at(-1)!.id,
            backlog: entries.length - next,
            dirty: changed ? 1 : p.dirty,
            completedRevision:
              next === entries.length ? revision : p.completedRevision,
            updatedAt: this.now(),
          };
          this.saveProgress(p);
        });
        commit();
        this.deps.inference.link(
          traceId,
          ...value.map((o) => ({ kind: "entry" as const, ref: o.entryId })),
        );
        this.deps.inference.link(
          traceId,
          ...value.map((o) => ({
            kind: "observation" as const,
            ref: observationId(threadId, o.entryId, o.observation),
          })),
        );
        this.deps.inference.annotate(traceId, {
          outcome: changed ? "applied" : "no-op",
          observationsAdded: inserted,
        });
        if (changed) this.generation++;
      }
      p = {
        ...p,
        completedRevision:
          next === entries.length ? revision : p.completedRevision,
        status: "idle",
        updatedAt: this.now(),
      };
      this.saveProgress(p);
      if (p.dirty) {
        const applied = await this.synthesize(threadId, controller.signal);
        if (!this.alive(threadId)) return;
        if (applied) p = { ...p, dirty: 0, updatedAt: this.now() };
        this.saveProgress(p);
      }
      this.deps.onChange();
    } catch (error) {
      if (this.alive(threadId)) {
        p = {
          ...p,
          status: "failed",
          error: redact(
            error instanceof Error ? error.message : String(error),
          ).slice(0, 500),
          updatedAt: this.now(),
        };
        this.saveProgress(p);
        this.deps.log(`Understanding failed for ${threadId}: ${p.error}`);
        this.deps.onChange();
      }
      if (this.alive(threadId)) throw error;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
  private async readEntries(
    threadId: string,
    signal: AbortSignal,
  ): Promise<Entry[]> {
    const rows: unknown[] = [];
    let before: { id: string; seq: number } | undefined;
    let complete = false;
    for (let page = 0; page < 60; page++) {
      const response = await this.deps.sdk().threads.timeline({
        threadId,
        includeNestedRows: "true",
        ...(before
          ? { beforeAnchorId: before.id, beforeAnchorSeq: String(before.seq) }
          : {}),
        signal,
      });
      if (!this.alive(threadId)) return [];
      rows.unshift(...response.rows);
      if (!response.timelinePage.hasOlderRows) {
        complete = true;
        break;
      }
      const cursor = response.timelinePage.olderCursor;
      if (
        !cursor ||
        (cursor.anchorId === before?.id && cursor.anchorSeq === before.seq)
      )
        break;
      before = { id: cursor.anchorId, seq: cursor.anchorSeq };
    }
    if (!complete)
      throw new Error(
        "Timeline exceeds bounded scan or has invalid pagination; progress was not advanced.",
      );
    const entries: Entry[] = [];
    const visit = (rows: unknown[]) => {
      for (const item of rows) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        // Turn children belong to this thread; delegated childRows do not.
        if (Array.isArray(row.children)) visit(row.children);
        if (
          row.kind !== "conversation" ||
          row.threadId !== threadId ||
          (row.role !== "user" && row.role !== "assistant") ||
          typeof row.id !== "string" ||
          typeof row.text !== "string"
        )
          continue;
        // System and agent-delivered messages aren't human statements. Their
        // claims can be learned from the assistant's attributed response.
        if (
          row.role === "user" &&
          row.initiator !== undefined &&
          row.initiator !== "user"
        )
          continue;
        const text = redact(row.text);
        if (!text.trim()) continue;
        for (let offset = 0; offset < text.length; offset += MAX_ENTRY_CHARS) {
          entries.push({
            id: `${row.id}#${offset}`,
            speaker: row.role,
            text: text.slice(offset, offset + MAX_ENTRY_CHARS),
            at: typeof row.createdAt === "number" ? row.createdAt : null,
            seq:
              typeof row.sourceSeqStart === "number"
                ? row.sourceSeqStart
                : entries.length,
          });
        }
      }
    };
    visit(rows);
    // Stable sort retains segment order; IDs are opaque, never chronological.
    return [
      ...new Map(
        entries.sort((a, b) => a.seq - b.seq).map((e) => [e.id, e]),
      ).values(),
    ];
  }
  private allMatchingObservations(query: string, limit = 80): Observation[] {
    const terms = termsOf(query).slice(0, 12);
    const where = terms.length
      ? `WHERE ${terms.map(() => "(lower(observation || ' ' || terms || ' ' || quote) LIKE ? ESCAPE '\\')").join(" OR ")}`
      : "";
    const escaped = terms.map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`);
    const rows = this.deps.db
      .prepare(
        `SELECT ${OBS_COLUMNS} FROM ws_understanding_observation ${where}
      ORDER BY COALESCE(source_at,created_at) DESC,id LIMIT 200`,
      )
      .all(...escaped) as ObservationRow[];
    const score = (o: Observation) =>
      terms.filter((t) =>
        `${o.observation} ${o.terms.join(" ")} ${o.quote}`
          .toLowerCase()
          .includes(t),
      ).length;
    return rows
      .map(decodeObservation)
      .sort(
        (a, b) =>
          score(b) - score(a) ||
          (b.sourceAt ?? 0) - (a.sourceAt ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, limit);
  }
  private matchingAccounts(query: string, limit = 8): Account[] {
    const terms = termsOf(query).slice(0, 12);
    const where = terms.length
      ? `WHERE ${terms.map(() => "lower(name || ' ' || narrative) LIKE ? ESCAPE '\\'").join(" OR ")}`
      : "";
    const rows = this.deps.db
      .prepare(
        `SELECT ${ACCOUNT_COLUMNS} FROM ws_understanding_account ${where} ORDER BY updated_at DESC LIMIT 80`,
      )
      .all(
        ...terms.map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`),
      ) as AccountRow[];
    const score = (a: Account) =>
      terms.filter((t) => `${a.name} ${a.narrative}`.toLowerCase().includes(t))
        .length;
    return rows
      .map(decodeAccount)
      .sort(
        (a, b) =>
          score(b) - score(a) ||
          b.updatedAt - a.updatedAt ||
          a.id.localeCompare(b.id),
      )
      .slice(0, limit);
  }
  private async synthesize(
    threadId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const own = (
      this.deps.db
        .prepare(
          `SELECT ${OBS_COLUMNS} FROM ws_understanding_observation WHERE thread_id = ? ORDER BY created_at DESC LIMIT 24`,
        )
        .all(threadId) as ObservationRow[]
    ).map(decodeObservation);
    if (!own.length) return true;
    const query = own
      .map((o) => `${o.terms.join(" ")} ${o.observation}`)
      .join(" ");
    const previous = this.matchingAccounts(query, 4);
    const related = this.allMatchingObservations(query, 60);
    const cited = previous
      .flatMap((a) => a.evidenceIds)
      .flatMap((id) => {
        const row = this.deps.db
          .prepare(
            `SELECT ${OBS_COLUMNS} FROM ws_understanding_observation WHERE id = ?`,
          )
          .get(id) as ObservationRow | undefined;
        return row ? [decodeObservation(row)] : [];
      });
    const observations: Observation[] = [];
    const seen = new Set<string>();
    // Recent facts from the triggering thread take priority, then competing
    // cross-thread evidence and evidence that grounds earlier accounts.
    for (const o of [...own, ...related, ...cited]) {
      if (seen.has(o.id)) continue;
      const candidate = { observations: [...observations, o], previous: [] };
      if (synthesisPrompt(candidate).length > MAX_PROMPT_CHARS - 6000) continue;
      observations.push(o);
      seen.add(o.id);
    }
    const supportedPrevious = previous.filter((a) =>
      a.evidenceIds.every((id) => seen.has(id)),
    );
    const input = { observations, previous: supportedPrevious };
    if (synthesisPrompt(input).length > MAX_PROMPT_CHARS)
      throw new Error("Reconciliation input exceeds its budget.");
    const generation = this.generation;
    const forgetGeneration = this.forgetGeneration;
    let traceId: string | null = null;
    let value: { accounts: Account[] };
    try {
      const result = await this.deps.inference.run(
        "understanding-synthesis",
        input,
        {
          model: await this.deps.model(),
          signal,
          label: `Understanding ${threadId}`,
          links: [{ kind: "thread", ref: threadId }],
        },
      );
      value = result.value as { accounts: Account[] };
      traceId = result.traceId;
    } catch (error) {
      const failedTraceId = traceIdOf(error);
      const retained = this.alive(threadId) && generation === this.generation;
      this.deps.inference.annotate(failedTraceId, {
        outcome: retained ? "failed" : "discarded",
        reason: retained
          ? redact(
              error instanceof Error ? error.message : String(error),
            ).slice(0, 300)
          : "evidence changed or service disposed",
      });
      if (forgetGeneration !== this.forgetGeneration)
        this.deps.inference.forgetTraces([failedTraceId]);
      throw error;
    }
    if (!this.alive(threadId) || generation !== this.generation) {
      this.deps.inference.annotate(traceId, {
        outcome: "discarded",
        reason: "evidence changed or service disposed",
      });
      if (forgetGeneration !== this.forgetGeneration)
        this.deps.inference.forgetTraces([traceId]);
      return false;
    }
    this.deps.inference.link(
      traceId,
      ...observations.map((item) => ({
        kind: "observation" as const,
        ref: item.id,
      })),
    );
    let added = 0;
    let revised = 0;
    let retired = 0;
    const commit = this.deps.db.transaction(() => {
      // Only accounts whose complete grounding was considered are in scope.
      // Omitted accounts in that set have been superseded or unsupported;
      // accounts outside the bounded input must remain untouched.
      const returned = new Set(
        value.accounts.map((a) =>
          observationId("account", a.name.toLowerCase(), ""),
        ),
      );
      for (const previous of supportedPrevious) {
        if (returned.has(previous.id)) continue;
        const prior = this.deps.db
          .prepare(
            `SELECT ${ACCOUNT_COLUMNS} FROM ws_understanding_account WHERE id=?`,
          )
          .get(previous.id) as AccountRow | undefined;
        if (!prior) continue;
        const before = belief(decodeAccount(prior));
        this.deps.db
          .prepare(
            "DELETE FROM ws_understanding_account_observation WHERE account_id=?",
          )
          .run(previous.id);
        this.deps.db
          .prepare("DELETE FROM ws_understanding_account WHERE id=?")
          .run(previous.id);
        this.deps.db
          .prepare(
            "INSERT INTO ws_understanding_revision (id,account_id,at,action,before,after,trace_id,reason) VALUES (?,?,?,?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            previous.id,
            this.revisionAt(previous.id),
            "retired",
            JSON.stringify(before),
            null,
            traceId,
            "No longer supported by the complete reconciliation evidence.",
          );
        retired++;
      }
      for (const account of value.accounts) {
        const id = observationId("account", account.name.toLowerCase(), "");
        const oldRow = this.deps.db
          .prepare(
            `SELECT ${ACCOUNT_COLUMNS} FROM ws_understanding_account WHERE id=?`,
          )
          .get(id) as AccountRow | undefined;
        const before = oldRow ? belief(decodeAccount(oldRow)) : null;
        const after = belief({
          ...account,
          id,
          updatedAt: this.now(),
          traceId,
        });
        const action = !before
          ? "created"
          : JSON.stringify({ ...before, updatedAt: 0, traceId: null }) ===
              JSON.stringify({ ...after, updatedAt: 0, traceId: null })
            ? null
            : "revised";
        if (action)
          this.deps.db
            .prepare(
              `INSERT INTO ws_understanding_account (id,name,narrative,questions,evidence_ids,updated_at,trace_id) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,narrative=excluded.narrative,questions=excluded.questions,evidence_ids=excluded.evidence_ids,updated_at=excluded.updated_at,trace_id=excluded.trace_id`,
            )
            .run(
              id,
              account.name,
              account.narrative,
              JSON.stringify(account.questions),
              JSON.stringify(account.evidenceIds),
              this.now(),
              traceId,
            );
        if (action) {
          this.deps.db
            .prepare(
              "INSERT INTO ws_understanding_revision (id,account_id,at,action,before,after,trace_id,reason) VALUES (?,?,?,?,?,?,?,?)",
            )
            .run(
              randomUUID(),
              id,
              this.revisionAt(id),
              action,
              before ? JSON.stringify(before) : null,
              JSON.stringify(after),
              traceId,
              action === "created"
                ? "Created from supported evidence."
                : "Reconciled from updated evidence.",
            );
          if (action === "created") added++;
          else revised++;
        }
        this.deps.db
          .prepare(
            "DELETE FROM ws_understanding_account_observation WHERE account_id = ?",
          )
          .run(id);
        for (const evidence of account.evidenceIds)
          this.deps.db
            .prepare(
              "INSERT INTO ws_understanding_account_observation (account_id,observation_id) VALUES (?,?)",
            )
            .run(id, evidence);
      }
    });
    commit();
    this.deps.inference.link(
      traceId,
      ...value.accounts.map((account) => ({
        kind: "account" as const,
        ref: observationId("account", account.name.toLowerCase(), ""),
      })),
    );
    this.deps.inference.annotate(traceId, {
      outcome: added || revised || retired ? "applied" : "no-op",
      accountsAdded: added,
      accountsRevised: revised,
      accountsRetired: retired,
    });
    return true;
  }
  context(query: string): string {
    return this.retrieve(query).context;
  }
  retrieve(
    query: string,
    options: { budget?: number; limit?: number } = {},
  ): RetrievalReport {
    return this.buildRetrieval(query, options);
  }
  private buildRetrieval(
    query: string,
    options: { budget?: number; limit?: number } = {},
  ): RetrievalReport {
    const budget = Math.min(
      Math.max(Math.floor(options.budget ?? 8000), 0),
      8000,
    );
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 20), 1), 100);
    const safeQuery = redact(query).slice(0, 2000);
    const terms = termsOf(safeQuery).slice(0, 12);
    const accounts = this.matchingAccounts(safeQuery, 80);
    const observations = this.allMatchingObservations(safeQuery, 80);
    const scoreAccount = (a: Account) =>
      terms.filter((t) => `${a.name} ${a.narrative}`.toLowerCase().includes(t))
        .length;
    const scoreObservation = (o: Observation) =>
      terms.filter((t) =>
        `${o.observation} ${o.terms.join(" ")} ${o.quote}`
          .toLowerCase()
          .includes(t),
      ).length;
    const blocks: string[] = [];
    const included = new Set<string>();
    const accountIds: string[] = [];
    const observationIds: string[] = [];
    const candidates: RetrievalReport["candidates"] = [];
    let usedChars = 0;
    const renderEvidence = (o: Observation) =>
      `Evidence ${o.id} [@thread:${o.threadId}, entry ${o.entryId}, ${o.speaker}, ${o.epistemic}, ${o.sourceAt === null ? "date unknown" : new Date(o.sourceAt).toISOString()}]: ${o.observation}\nQuote: ${o.quote}`;
    const add = (text: string) => {
      const chars = text.length + (blocks.length ? 2 : 0);
      if (usedChars + chars > budget) return false;
      blocks.push(text);
      usedChars += chars;
      return true;
    };
    let accountRank = 0;
    for (const account of accounts) {
      const grounded = account.evidenceIds.map((id) => {
        const row = this.deps.db
          .prepare(
            `SELECT ${OBS_COLUMNS} FROM ws_understanding_observation WHERE id=?`,
          )
          .get(id) as ObservationRow | undefined;
        return row ? decodeObservation(row) : null;
      });
      const score = scoreAccount(account);
      const matchedTerms = terms.filter((t) =>
        `${account.name} ${account.narrative}`.toLowerCase().includes(t),
      );
      const title = account.name;
      if (grounded.some((item) => !item)) {
        candidates.push({
          kind: "account",
          id: account.id,
          title,
          score,
          matchedTerms,
          disposition: "missing-evidence",
          chars: 0,
        });
        continue;
      }
      const grounding = (grounded as Observation[])
        .map(renderEvidence)
        .join("\n\n");
      const interpretation = `Account (interpretation, updated ${new Date(account.updatedAt).toISOString()}): ${account.name}: ${account.narrative}\nQuestions: ${account.questions.join("; ")}\nCitations: ${account.evidenceIds.join(", ")}`;
      const text = `${grounding}\n\n${interpretation}`;
      const chars = text.length + (blocks.length ? 2 : 0);
      let disposition: "included" | "budget" | "limit" | "covered" = "included";
      if (accountRank >= Math.min(4, limit)) disposition = "limit";
      else if (!add(text)) disposition = "budget";
      else {
        accountRank++;
        accountIds.push(account.id);
        grounded.forEach((o) => {
          if (!o) return;
          included.add(o.id);
          if (!observationIds.includes(o.id)) observationIds.push(o.id);
        });
      }
      candidates.push({
        kind: "account",
        id: account.id,
        title,
        score,
        matchedTerms,
        disposition,
        chars: disposition === "included" ? chars : 0,
      });
    }
    let observationRank = 0;
    for (const o of observations) {
      if (candidates.length >= 100) break;
      const score = scoreObservation(o);
      const matchedTerms = terms.filter((t) =>
        `${o.observation} ${o.terms.join(" ")} ${o.quote}`
          .toLowerCase()
          .includes(t),
      );
      const title = o.observation.slice(0, 120);
      let disposition: "included" | "budget" | "limit" | "covered" = "included";
      let chars = 0;
      if (included.has(o.id)) disposition = "covered";
      else if (observationRank >= 16 || accountRank + observationRank >= limit)
        disposition = "limit";
      else {
        const text = renderEvidence(o);
        chars = text.length + (blocks.length ? 2 : 0);
        if (!add(text)) disposition = "budget";
        else {
          observationRank++;
          observationIds.push(o.id);
          included.add(o.id);
        }
      }
      candidates.push({
        kind: "observation",
        id: o.id,
        title,
        score,
        matchedTerms,
        disposition,
        chars: disposition === "included" ? chars : 0,
      });
    }
    return retrievalReportSchema.parse({
      query: safeQuery,
      terms,
      budget,
      usedChars,
      context: blocks.join("\n\n"),
      accountIds,
      observationIds,
      candidates: candidates.slice(0, 100),
    });
  }
  debugOverview(
    options: { query?: string; offset?: number; limit?: number } = {},
  ): DebugOverview {
    const query = options.query?.trim() ?? "";
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50)), 100);
    const accountTerms = termsOf(query).slice(0, 12);
    const observationTerms = accountTerms;
    const accountWhere = accountTerms.length
      ? `WHERE ${accountTerms.map(() => "lower(name || ' ' || narrative) LIKE ? ESCAPE '\\'").join(" OR ")}`
      : "";
    const obsWhere = observationTerms.length
      ? `WHERE ${observationTerms.map(() => "lower(observation || ' ' || terms || ' ' || quote) LIKE ? ESCAPE '\\'").join(" OR ")}`
      : "";
    const escaped = (terms: string[]) =>
      terms.map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`);
    const accounts = this.deps.db
      .prepare(
        `SELECT ${ACCOUNT_COLUMNS} FROM ws_understanding_account ${accountWhere} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`,
      )
      .all(...escaped(accountTerms), limit + 1, offset) as AccountRow[];
    const observations = this.deps.db
      .prepare(
        `SELECT ${OBS_COLUMNS} FROM ws_understanding_observation ${obsWhere} ORDER BY COALESCE(source_at,created_at) DESC,id LIMIT ? OFFSET ?`,
      )
      .all(...escaped(observationTerms), limit + 1, offset) as ObservationRow[];
    const progress = this.deps.db
      .prepare(
        `SELECT ${PROGRESS_COLUMNS} FROM ws_understanding_progress ORDER BY updated_at DESC,thread_id LIMIT ? OFFSET ?`,
      )
      .all(limit + 1, offset) as Progress[];
    const health = this.deps.db
      .prepare(
        `SELECT count(*) AS threads, sum(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed, sum(CASE WHEN backlog>0 OR dirty>0 THEN 1 ELSE 0 END) AS pending FROM ws_understanding_progress`,
      )
      .get() as {
      threads: number;
      failed: number | null;
      pending: number | null;
    };
    return debugOverviewSchema.parse({
      accounts: accounts.slice(0, limit).map(decodeAccount).map(belief),
      observations: observations
        .slice(0, limit)
        .map(decodeObservation)
        .map(evidence),
      progress: progress.slice(0, limit),
      counts: {
        accounts: Number(
          (
            this.deps.db
              .prepare("SELECT count(*) AS n FROM ws_understanding_account")
              .all() as { n: number }[]
          )[0]?.n ?? 0,
        ),
        observations: Number(
          (
            this.deps.db
              .prepare("SELECT count(*) AS n FROM ws_understanding_observation")
              .all() as { n: number }[]
          )[0]?.n ?? 0,
        ),
        threads: health.threads,
        failed: health.failed ?? 0,
        pending: health.pending ?? 0,
      },
      hasMoreAccounts: accounts.length > limit,
      hasMoreObservations: observations.length > limit,
      hasMoreProgress: progress.length > limit,
    });
  }
  accountDetail(id: string, before?: number): AccountDetail {
    const row = this.deps.db
      .prepare(
        `SELECT ${ACCOUNT_COLUMNS} FROM ws_understanding_account WHERE id=?`,
      )
      .get(id) as AccountRow | undefined;
    const current = row ? decodeAccount(row) : null;
    const evidenceRows = this.deps.db
      .prepare(
        `SELECT ${OBS_COLUMNS} FROM ws_understanding_observation o JOIN ws_understanding_account_observation l ON l.observation_id=o.id WHERE l.account_id=? ORDER BY COALESCE(o.source_at,o.created_at) DESC,o.id`,
      )
      .all(id) as ObservationRow[];
    const revisions = this.deps.db
      .prepare(
        "SELECT id,account_id AS accountId,at,action,before,after,trace_id AS traceId,reason FROM ws_understanding_revision WHERE account_id=? AND (? IS NULL OR at < ?) ORDER BY at DESC,id DESC LIMIT 51",
      )
      .all(id, before ?? null, before ?? null) as (Omit<
      Revision,
      "before" | "after"
    > & { before: string | null; after: string | null })[];
    const decoded = revisions.slice(0, 50).map((r) => ({
      ...r,
      before: r.before ? JSON.parse(r.before) : null,
      after: r.after ? JSON.parse(r.after) : null,
    }));
    return accountDetailSchema.parse({
      account: current ? belief(current) : null,
      evidence: evidenceRows.map(decodeObservation).map(evidence),
      revisions: decoded,
      hasMoreRevisions: revisions.length > 50,
    });
  }
  observationDetail(id: string): ObservationDetail {
    const row = this.deps.db
      .prepare(
        `SELECT ${OBS_COLUMNS} FROM ws_understanding_observation WHERE id=?`,
      )
      .get(id) as ObservationRow | undefined;
    const accounts = this.deps.db
      .prepare(
        `SELECT ${ACCOUNT_COLUMNS} FROM ws_understanding_account a JOIN ws_understanding_account_observation l ON l.account_id=a.id WHERE l.observation_id=? ORDER BY a.updated_at DESC,a.id LIMIT 100`,
      )
      .all(id) as AccountRow[];
    const snapshots = this.deps.db
      .prepare(
        `SELECT id,at,consumer,thread_id,trace_id,report FROM ws_understanding_retrieval r WHERE EXISTS (SELECT 1 FROM json_each(r.report,'$.observationIds') j WHERE j.value=?) ORDER BY at DESC,id DESC LIMIT 20`,
      )
      .all(id) as SnapshotRow[];
    return observationDetailSchema.parse({
      observation: row ? evidence(decodeObservation(row)) : null,
      accounts: accounts.map(decodeAccount).map(belief),
      retrievals: snapshots.map(this.decodeSnapshot),
    });
  }
  private decodeSnapshot = (row: SnapshotRow): RetrievalSnapshot =>
    retrievalSnapshotSchema.parse({
      id: row.id,
      at: row.at,
      consumer: row.consumer,
      threadId: row.thread_id,
      traceId: row.trace_id,
      report: JSON.parse(row.report),
    });
  recordRetrieval(
    report: RetrievalReport,
    consumer: "analysis" | "route",
    threadId: string | null,
  ): string {
    const checked = retrievalReportSchema.parse(report);
    const id = randomUUID();
    const safe = retrievalReportSchema.parse(
      JSON.parse(
        JSON.stringify(checked, (_key, value) =>
          typeof value === "string" ? redact(value) : value,
        ),
      ),
    );
    const commit = this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          "INSERT INTO ws_understanding_retrieval (id,at,consumer,thread_id,trace_id,report) VALUES (?,?,?,?,NULL,?)",
        )
        .run(id, this.now(), consumer, threadId, JSON.stringify(safe));
      this.deps.db
        .prepare(
          "DELETE FROM ws_understanding_retrieval WHERE id NOT IN (SELECT id FROM ws_understanding_retrieval ORDER BY at DESC,rowid DESC LIMIT 1000)",
        )
        .run();
    });
    commit();
    return id;
  }
  attachRetrieval(id: string, traceId: string | null): void {
    if (this.disposed) return;
    const exists = this.deps.db
      .prepare("SELECT id FROM ws_understanding_retrieval WHERE id=?")
      .get(id);
    if (!exists) {
      // Snapshot eviction or source removal can precede completion. Without
      // its provenance, retaining this prompt would defeat source forgetting.
      this.deps.inference.forgetTraces([traceId]);
      return;
    }
    this.deps.db
      .prepare("UPDATE ws_understanding_retrieval SET trace_id=? WHERE id=?")
      .run(traceId, id);
    this.deps.inference.link(traceId, { kind: "retrieval", ref: id });
    const report = this.deps.db
      .prepare("SELECT report FROM ws_understanding_retrieval WHERE id=?")
      .get(id) as { report: string } | undefined;
    if (!report) return;
    const parsed = retrievalReportSchema.parse(JSON.parse(report.report));
    this.deps.inference.link(
      traceId,
      ...[
        ...parsed.accountIds.map((ref) => ({ kind: "account" as const, ref })),
        ...parsed.observationIds.map((ref) => ({
          kind: "observation" as const,
          ref,
        })),
      ],
    );
  }
  retrievalCursor(id: string): { at: number; id: string } | undefined {
    const row = this.deps.db
      .prepare("SELECT at,id FROM ws_understanding_retrieval WHERE id=?")
      .get(id) as { at: number; id: string } | undefined;
    return row;
  }
  retrievals(
    options: {
      traceId?: string;
      threadId?: string;
      limit?: number;
      before?: { at: number; id: string };
    } = {},
  ): RetrievalSnapshot[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.traceId) {
      where.push("trace_id=?");
      params.push(options.traceId);
    }
    if (options.threadId) {
      where.push("thread_id=?");
      params.push(options.threadId);
    }
    if (options.before) {
      where.push("(at < ? OR (at = ? AND id < ?))");
      params.push(options.before.at, options.before.at, options.before.id);
    }
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 100);
    const rows = this.deps.db
      .prepare(
        `SELECT id,at,consumer,thread_id,trace_id,report FROM ws_understanding_retrieval ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC,id DESC LIMIT ?`,
      )
      .all(...params, limit) as SnapshotRow[];
    return rows.map(this.decodeSnapshot);
  }
  inspect(query = "") {
    const accounts = this.matchingAccounts(query);
    const observations = this.allMatchingObservations(query, 40);
    const seen = new Set(observations.map((o) => o.id));
    for (const account of accounts) {
      for (const id of account.evidenceIds) {
        if (seen.has(id) || observations.length >= 80) continue;
        const row = this.deps.db
          .prepare(
            `SELECT ${OBS_COLUMNS} FROM ws_understanding_observation WHERE id = ?`,
          )
          .get(id) as ObservationRow | undefined;
        if (row) {
          observations.push(decodeObservation(row));
          seen.add(id);
        }
      }
    }
    const progress = this.deps.db
      .prepare(
        `SELECT ${PROGRESS_COLUMNS} FROM ws_understanding_progress ORDER BY updated_at DESC LIMIT 80`,
      )
      .all() as Progress[];
    const health = this.deps.db
      .prepare(
        `SELECT count(*) AS threads,
      sum(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      sum(CASE WHEN backlog>0 OR dirty>0 THEN 1 ELSE 0 END) AS pending FROM ws_understanding_progress`,
      )
      .get() as {
      threads: number;
      failed: number | null;
      pending: number | null;
    };
    return {
      accounts,
      observations,
      progress,
      questions: accounts.flatMap((a) => a.questions).slice(0, 30),
      health,
    };
  }
  forget(threadId: string): void {
    if (this.disposed) return;
    this.deleted.add(threadId);
    this.generation++;
    this.forgetGeneration++;
    const traceIds = new Set<string>();
    const observationLinks: { kind: "observation"; ref: string }[] = [];
    const accountLinks: { kind: "account"; ref: string }[] = [];
    const retrievalLinks: { kind: "retrieval"; ref: string }[] = [];
    const commit = this.deps.db.transaction(() => {
      const affected = this.deps.db
        .prepare(
          `SELECT DISTINCT a.id FROM ws_understanding_account a JOIN ws_understanding_account_observation l ON l.account_id=a.id JOIN ws_understanding_observation o ON o.id=l.observation_id WHERE o.thread_id=?`,
        )
        .all(threadId) as { id: string }[];
      const invalidObservations = this.deps.db
        .prepare(
          "SELECT id,trace_id AS traceId FROM ws_understanding_observation WHERE thread_id=?",
        )
        .all(threadId) as { id: string; traceId: string | null }[];
      const invalidIds = invalidObservations.map((r) => r.id);
      for (const item of invalidObservations) {
        if (item.traceId) traceIds.add(item.traceId);
        observationLinks.push({ kind: "observation", ref: item.id });
      }
      for (const account of affected) {
        accountLinks.push({ kind: "account", ref: account.id });
        const revisionTraces = this.deps.db
          .prepare(
            "SELECT trace_id AS traceId FROM ws_understanding_revision WHERE account_id=?",
          )
          .all(account.id) as { traceId: string | null }[];
        for (const row of revisionTraces)
          if (row.traceId) traceIds.add(row.traceId);
      }
      for (const account of affected) {
        const row = this.deps.db
          .prepare(
            `SELECT ${ACCOUNT_COLUMNS} FROM ws_understanding_account WHERE id=?`,
          )
          .get(account.id) as AccountRow | undefined;
        if (row?.traceId) traceIds.add(row.traceId);
        if (row)
          this.deps.db
            .prepare(
              "INSERT INTO ws_understanding_revision (id,account_id,at,action,before,after,trace_id,reason) VALUES (?,?,?,?,?,?,?,?)",
            )
            .run(
              randomUUID(),
              account.id,
              this.revisionAt(account.id),
              "retired",
              null,
              null,
              null,
              "Retired because supporting source evidence was forgotten.",
            );
        this.deps.db
          .prepare("DELETE FROM ws_understanding_account WHERE id=?")
          .run(account.id);
        this.deps.db
          .prepare(
            "DELETE FROM ws_understanding_account_observation WHERE account_id=?",
          )
          .run(account.id);
        // Older revision beliefs may paraphrase forgotten source text; retain only safe lifecycle metadata.
        this.deps.db
          .prepare(
            "UPDATE ws_understanding_revision SET before=NULL,after=NULL,reason='History redacted because supporting source evidence was forgotten.' WHERE account_id=?",
          )
          .run(account.id);
      }
      const affectedIds = new Set(affected.map((account) => account.id));
      const history = this.deps.db
        .prepare(
          "SELECT id,account_id,before,after FROM ws_understanding_revision",
        )
        .all() as {
        id: string;
        account_id: string;
        before: string | null;
        after: string | null;
      }[];
      for (const item of history) {
        const referencesForgotten = [item.before, item.after].some(
          (encoded) => {
            if (!encoded) return false;
            try {
              const belief = JSON.parse(encoded) as Belief;
              return belief.evidenceIds.some((id) => invalidIds.includes(id));
            } catch {
              return false;
            }
          },
        );
        if (referencesForgotten) affectedIds.add(item.account_id);
      }
      for (const accountId of affectedIds) {
        const revisionTraces = this.deps.db
          .prepare(
            "SELECT trace_id AS traceId FROM ws_understanding_revision WHERE account_id=?",
          )
          .all(accountId) as { traceId: string | null }[];
        for (const row of revisionTraces)
          if (row.traceId) traceIds.add(row.traceId);
        this.deps.db
          .prepare(
            "UPDATE ws_understanding_revision SET before=NULL,after=NULL,reason='History redacted because supporting source evidence was forgotten.' WHERE account_id=?",
          )
          .run(accountId);
      }
      const snapshots = this.deps.db
        .prepare(
          "SELECT id,trace_id AS traceId,thread_id AS threadId,report FROM ws_understanding_retrieval",
        )
        .all() as {
        id: string;
        traceId: string | null;
        threadId: string | null;
        report: string;
      }[];
      for (const snapshot of snapshots) {
        let report: RetrievalReport;
        try {
          report = JSON.parse(snapshot.report) as RetrievalReport;
        } catch {
          continue;
        }
        const cited = new Set([
          ...report.observationIds,
          ...report.candidates
            .filter((c) => c.kind === "observation")
            .map((c) => c.id),
        ]);
        const owner = this.deps.db
          .prepare(
            "SELECT thread_id FROM ws_understanding_retrieval WHERE id=?",
          )
          .get(snapshot.id) as { thread_id: string | null } | undefined;
        if (
          owner?.thread_id === threadId ||
          invalidIds.some((id) => cited.has(id)) ||
          report.accountIds.some((id) => affectedIds.has(id)) ||
          report.candidates.some(
            (candidate) =>
              candidate.kind === "account" && affectedIds.has(candidate.id),
          )
        ) {
          if (snapshot.traceId) traceIds.add(snapshot.traceId);
          retrievalLinks.push({ kind: "retrieval", ref: snapshot.id });
          this.deps.db
            .prepare("DELETE FROM ws_understanding_retrieval WHERE id=?")
            .run(snapshot.id);
        }
      }
      this.deps.db
        .prepare("DELETE FROM ws_understanding_observation WHERE thread_id=?")
        .run(threadId);
      this.deps.db
        .prepare("DELETE FROM ws_understanding_progress WHERE thread_id=?")
        .run(threadId);
      // Surviving evidence can support fresh accounts after invalidation.
      this.deps.db
        .prepare("UPDATE ws_understanding_progress SET dirty=1")
        .run();
    });
    commit();
    this.deps.inference.forgetTraces(
      [...traceIds],
      [
        { kind: "thread", ref: threadId },
        ...observationLinks,
        ...accountLinks,
        ...retrievalLinks,
      ],
    );
    this.deps.onChange();
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.controller?.abort();
  }
}
