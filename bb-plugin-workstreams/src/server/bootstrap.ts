/**
 * One-time organizing (SPEC §8), also `bb workstreams rebuild`:
 *
 * 1. Intake: roots, sections, and who filed each root. v1's change log marks
 *    the filings v1 made automatically; those, and unfiled roots, are
 *    re-evaluated. Every other filing is the user's and stays put.
 * 2. Map proposal: one model call proposes renames, merges, new workstreams,
 *    and descriptions.
 * 3. Review: the user accepts or rejects each change.
 * 4. Assignment: closed-set calls, eight roots per call, four at a time.
 * 5. Apply: the previewed diff, as one journaled batch that undoes as a whole.
 *
 * Nothing changes in BB before step 5. Evolution and auto-filing stay off
 * until the bootstrap is applied or skipped.
 */
import { buildForest } from "../domain/tree.ts";
import {
  detectProposals,
  normalize,
  snoozeKey,
  type EvolutionRoot,
} from "../domain/evolution.ts";
import {
  ASSIGN_BATCH,
  assignPrompt,
  mapPrompt,
  parseAssignments,
  parseMapProposal,
  type Assignment,
  type MapChange,
} from "../domain/organize.ts";
import type { Analyzer } from "./analyzer.ts";
import { getMeta, setMeta, type Database } from "./db.ts";
import type { WorkstreamMap } from "./map.ts";
import type { BatchPlan, WorkstreamService } from "./service.ts";
import { UserError } from "./service.ts";

type Complete = (prompt: string, model: string) => Promise<{ text: string }>;

export type Provenance = "user" | "auto" | "unfiled";

export type BootstrapMove = {
  threadId: string;
  title: string;
  from: string | null;
  fromName: string;
  /** Section id, or `new:<name>` for a workstream the batch creates. */
  to: string;
  toName: string;
  reason: string;
  accepted: boolean;
  /** Set for moves from the evolution engine: snoozed if left unchecked. */
  key?: string;
  evidenceCount?: number;
};

export type BootstrapState = {
  status:
    | "proposing"
    | "review"
    | "assigning"
    | "preview"
    | "applying"
    | "applied"
    | "failed";
  startedAt: number;
  updatedAt: number;
  error: string | null;
  roots: {
    id: string;
    title: string;
    sectionId: string | null;
    provenance: Provenance;
  }[];
  descriptions: Record<string, string>;
  changes: (MapChange & { id: string; accepted: boolean })[];
  preview: {
    creates: { name: string; description: string | null }[];
    renames: { sectionId: string; from: string; to: string }[];
    moves: BootstrapMove[];
    unsure: { threadId: string; title: string }[];
  } | null;
  entryId: string | null;
  seconds: { intake: number; map: number; assign: number; apply: number };
};

const KEY = "bootstrap";
const CONCURRENCY = 4;
const NEW_PREFIX = "new:";

export class Bootstrap {
  private running: Promise<unknown> | null = null;

  constructor(
    private readonly deps: {
      db: Database;
      service: WorkstreamService;
      analyzer: Analyzer;
      map: WorkstreamMap;
      complete: Complete;
      model: () => Promise<string>;
      onChange: () => void;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  isDone(): boolean {
    return getMeta(this.deps.db, "bootstrapped") === "1";
  }

  state(): BootstrapState | null {
    const raw = getMeta(this.deps.db, KEY);
    return raw ? (JSON.parse(raw) as BootstrapState) : null;
  }

  private save(state: BootstrapState): BootstrapState {
    const next = { ...state, updatedAt: this.now() };
    setMeta(this.deps.db, KEY, JSON.stringify(next));
    this.deps.onChange();
    return next;
  }

  private busy(): void {
    if (this.running) throw new UserError("Organizing is already running.");
  }

  /** Steps 1–2. Resolves once the map proposal is ready for review. */
  async start(): Promise<BootstrapState> {
    this.busy();
    const work = this.propose();
    this.running = work;
    try {
      return await work;
    } finally {
      this.running = null;
    }
  }

  private async propose(): Promise<BootstrapState> {
    const startedAt = this.now();
    let state: BootstrapState = this.save({
      status: "proposing",
      startedAt,
      updatedAt: startedAt,
      error: null,
      roots: [],
      descriptions: {},
      changes: [],
      preview: null,
      entryId: null,
      seconds: { intake: 0, map: 0, assign: 0, apply: 0 },
    });
    try {
      await this.deps.service.reconcile();
    } catch (error) {
      return this.save({ ...state, status: "failed", error: String(error) });
    }
    const roots = this.intake();
    state = this.save({
      ...state,
      roots,
      seconds: { ...state.seconds, intake: (this.now() - startedAt) / 1000 },
    });
    const mapStarted = this.now();
    try {
      const analysis = this.deps.analyzer.all();
      const records = this.deps.map.list();
      const subject = (id: string) => analysis[id]?.subject ?? null;
      const titled = new Map(roots.map((r) => [r.id, r.title]));
      const prompt = mapPrompt({
        workstreams: records.map((record) => ({
          name: record.name,
          description: record.description,
          roots: roots
            .filter((r) => r.sectionId === record.sectionId)
            .map((r) => ({ title: titled.get(r.id)!, subject: subject(r.id) })),
        })),
        unfiled: roots
          .filter((r) => r.provenance !== "user")
          .map((r) => ({ title: r.title, subject: subject(r.id) })),
      });
      const { text } = await this.deps.complete(
        prompt,
        await this.deps.model(),
      );
      const proposal = parseMapProposal(
        text,
        records.map((r) => r.name),
      );
      state = this.save({
        ...state,
        status: "review",
        descriptions: proposal.descriptions,
        changes: proposal.changes.map((change, i) => ({
          ...change,
          id: `c${i}`,
          accepted: true,
        })),
        seconds: { ...state.seconds, map: (this.now() - mapStarted) / 1000 },
      });
      return state;
    } catch (error) {
      return this.save({ ...state, status: "failed", error: String(error) });
    }
  }

  /** Steps 3–4: the reviewed map, then closed-set assignment. */
  async assign(
    decisions: { id: string; accepted: boolean; name?: string }[],
  ): Promise<BootstrapState> {
    this.busy();
    const current = this.state();
    if (!current || current.status !== "review")
      throw new UserError("Start organizing first.");
    const work = this.runAssign(current, decisions);
    this.running = work;
    try {
      return await work;
    } finally {
      this.running = null;
    }
  }

  private async runAssign(
    current: BootstrapState,
    decisions: { id: string; accepted: boolean; name?: string }[],
  ): Promise<BootstrapState> {
    const byId = new Map(decisions.map((d) => [d.id, d]));
    const changes = current.changes.map((change) => {
      const decision = byId.get(change.id);
      if (!decision) return change;
      const named =
        decision.name && (change.kind === "rename" || change.kind === "create")
          ? { ...change, name: decision.name.trim() || change.name }
          : change;
      return { ...named, accepted: decision.accepted };
    });
    let state = this.save({ ...current, status: "assigning", changes });
    const started = this.now();
    try {
      const records = this.deps.map.list();
      const idOf = new Map(
        records.map((r) => [r.name.toLowerCase(), r.sectionId]),
      );
      const nameOf = new Map(records.map((r) => [r.sectionId, r.name]));
      const accepted = changes.filter((c) => c.accepted);
      const renames = accepted.flatMap((c) =>
        c.kind === "rename" && idOf.has(c.workstream.toLowerCase())
          ? [
              {
                sectionId: idOf.get(c.workstream.toLowerCase())!,
                from: c.workstream,
                to: c.name,
              },
            ]
          : [],
      );
      const renamed = new Map(renames.map((r) => [r.sectionId, r.to]));
      const finalName = (sectionId: string) =>
        renamed.get(sectionId) ?? nameOf.get(sectionId) ?? "";
      const mergedAway = new Map(
        accepted.flatMap((c) =>
          c.kind === "merge" &&
          idOf.has(c.workstream.toLowerCase()) &&
          idOf.has(c.into.toLowerCase())
            ? [
                [
                  idOf.get(c.workstream.toLowerCase())!,
                  idOf.get(c.into.toLowerCase())!,
                ] as const,
              ]
            : [],
        ),
      );
      const creates = new Map<
        string,
        { name: string; description: string | null }
      >();
      for (const c of accepted)
        if (c.kind === "create")
          creates.set(normalize(c.name), {
            name: c.name,
            description: c.description || null,
          });

      const options = [
        ...records
          .filter((r) => !mergedAway.has(r.sectionId))
          .map((r) => ({
            name: finalName(r.sectionId),
            description: current.descriptions[r.name] ?? r.description ?? null,
            to: r.sectionId,
          })),
        ...[...creates.values()].map((c) => ({
          name: c.name,
          description: c.description,
          to: `${NEW_PREFIX}${c.name}`,
        })),
      ];
      const optionByName = new Map(
        options.map((o) => [o.name.toLowerCase(), o]),
      );

      const analysis = this.deps.analyzer.all();
      const pending = state.roots.filter((r) => r.provenance !== "user");
      const batches: (typeof pending)[] = [];
      for (let i = 0; i < pending.length; i += ASSIGN_BATCH)
        batches.push(pending.slice(i, i + ASSIGN_BATCH));
      const model = await this.deps.model();
      const results: Assignment[] = [];
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(CONCURRENCY, batches.length) },
          async () => {
            while (next < batches.length) {
              const batch = batches[next++]!;
              const ids = batch.map((r) => r.id);
              try {
                const { text } = await this.deps.complete(
                  assignPrompt({
                    workstreams: options,
                    threads: batch.map((r) => ({
                      id: r.id,
                      title: r.title,
                      subject: analysis[r.id]?.subject ?? null,
                      recap: analysis[r.id]?.recap ?? null,
                    })),
                  }),
                  model,
                );
                results.push(
                  ...parseAssignments(
                    text,
                    ids,
                    options.map((o) => o.name),
                  ),
                );
              } catch {
                results.push(
                  ...ids.map((id): Assignment => ({
                    id,
                    confidence: "low",
                    target: { kind: "unsure" },
                  })),
                );
              }
            }
          },
        ),
      );

      // A new workstream needs two roots, or an accepted create.
      const freshCounts = new Map<string, number>();
      for (const a of results)
        if (a.target.kind === "new")
          freshCounts.set(
            normalize(a.target.name),
            (freshCounts.get(normalize(a.target.name)) ?? 0) + 1,
          );
      const moves: BootstrapMove[] = [];
      const unsure: { threadId: string; title: string }[] = [];
      const rootById = new Map(state.roots.map((r) => [r.id, r]));
      const fromName = (sectionId: string | null) =>
        sectionId
          ? (nameOf.get(sectionId) ?? "a deleted workstream")
          : "Unsorted";
      for (const a of results) {
        const root = rootById.get(a.id)!;
        let option =
          a.target.kind === "existing"
            ? optionByName.get(a.target.name.toLowerCase())
            : undefined;
        if (a.target.kind === "new") {
          const key = normalize(a.target.name);
          if (creates.has(key) || (freshCounts.get(key) ?? 0) >= 2) {
            if (!creates.has(key))
              creates.set(key, { name: a.target.name, description: null });
            const name = creates.get(key)!.name;
            option = { name, description: null, to: `${NEW_PREFIX}${name}` };
          }
        }
        if (!option) {
          unsure.push({ threadId: a.id, title: root.title });
          continue;
        }
        if (option.to === root.sectionId) continue;
        moves.push({
          threadId: a.id,
          title: root.title,
          from: root.sectionId,
          fromName: fromName(root.sectionId),
          to: option.to,
          toName: option.name,
          reason: `${a.confidence} confidence`,
          accepted: a.confidence !== "low",
        });
      }
      // Roots in a merged-away workstream follow the merge.
      for (const root of state.roots) {
        const into = root.sectionId
          ? mergedAway.get(root.sectionId)
          : undefined;
        if (!into || moves.some((m) => m.threadId === root.id)) continue;
        moves.push({
          threadId: root.id,
          title: root.title,
          from: root.sectionId,
          fromName: fromName(root.sectionId),
          to: into,
          toName: finalName(into),
          reason: "merge",
          accepted: true,
        });
      }
      // The evolution engine, relaxed, over roots the user filed. These are
      // offered unchecked: a user filing only moves with the user's say-so.
      const evolutionRoots: EvolutionRoot[] = state.roots
        .filter((r) => r.provenance === "user")
        .map((r) => ({
          id: r.id,
          sectionId: r.sectionId,
          subject: analysis[r.id]?.subject ?? null,
          active: true,
          lastActiveAt: this.now(),
          userMovedAt: null,
        }));
      const candidates = detectProposals(
        evolutionRoots,
        records.map((r) => ({
          id: r.sectionId,
          name: r.name,
          aliases: r.aliases,
        })),
        { now: this.now(), sensitivity: "responsive", relaxed: true },
      );
      for (const candidate of candidates)
        for (const threadId of candidate.threadIds) {
          if (moves.some((m) => m.threadId === threadId)) continue;
          const root = rootById.get(threadId)!;
          const name =
            candidate.newName ?? finalName(candidate.targetSectionId!);
          if (candidate.newName && !creates.has(normalize(name)))
            creates.set(normalize(name), { name, description: null });
          moves.push({
            threadId,
            title: root.title,
            from: root.sectionId,
            fromName: fromName(root.sectionId),
            to: candidate.targetSectionId ?? `${NEW_PREFIX}${name}`,
            toName: name,
            reason: `${candidate.kind} (you filed this thread)`,
            accepted: false,
            key: candidate.key,
            evidenceCount: candidate.evidenceCount,
          });
        }

      // A new workstream for a single thread starts unchecked: new
      // workstreams need two roots unless the user opts in.
      const perTarget = new Map<string, number>();
      for (const m of moves)
        perTarget.set(m.to, (perTarget.get(m.to) ?? 0) + 1);
      for (const m of moves)
        if (m.to.startsWith(NEW_PREFIX) && (perTarget.get(m.to) ?? 0) < 2)
          m.accepted = false;
      state = this.save({
        ...state,
        status: "preview",
        preview: {
          creates: [...creates.values()],
          renames,
          moves,
          unsure,
        },
        seconds: { ...state.seconds, assign: (this.now() - started) / 1000 },
      });
      return state;
    } catch (error) {
      return this.save({ ...state, status: "failed", error: String(error) });
    }
  }

  /** Step 5. `rejected` lists moves the user unchecked in the preview. */
  async apply(
    overrides: { threadId: string; accepted: boolean }[] = [],
  ): Promise<BootstrapState> {
    this.busy();
    const work = this.runApply(overrides);
    this.running = work;
    try {
      return await work;
    } finally {
      this.running = null;
    }
  }

  private async runApply(
    overrides: { threadId: string; accepted: boolean }[],
  ): Promise<BootstrapState> {
    const current = this.state();
    if (!current || current.status !== "preview" || !current.preview)
      throw new UserError("Nothing to apply yet.");
    const started = this.now();
    let state = this.save({ ...current, status: "applying" });
    const override = new Map(overrides.map((o) => [o.threadId, o.accepted]));
    const moves = current.preview.moves.filter(
      (m) => override.get(m.threadId) ?? m.accepted,
    );
    const used = new Set(moves.map((m) => m.to));
    const plan: BatchPlan = {
      creates: current.preview.creates
        .filter((c) => used.has(`${NEW_PREFIX}${c.name}`))
        .map((c) => ({
          key: `${NEW_PREFIX}${c.name}`,
          name: c.name,
          description: c.description,
        })),
      renames: current.preview.renames.map((r) => ({
        sectionId: r.sectionId,
        name: r.to,
      })),
      moves: moves.map((m) => ({
        threadId: m.threadId,
        from: m.from,
        to: m.to,
      })),
      descriptions: Object.entries(current.descriptions).flatMap(
        ([name, description]) => {
          const record = this.deps.map.list().find((r) => r.name === name);
          return record
            ? [[record.sectionId, description] as [string, string]]
            : [];
        },
      ),
    };
    try {
      const touched = new Set(
        moves.flatMap((m) => [m.from, m.to]).filter(Boolean),
      );
      const { entry, skipped } = await this.deps.service.applyBatch(
        plan,
        "bootstrap",
        `Organized ${moves.length} thread${moves.length === 1 ? "" : "s"} across ${touched.size} workstreams`,
      );
      // A move left unchecked is the user's call: the thread stays, and an
      // evolution candidate behind it is snoozed like a dismissal.
      for (const move of current.preview.moves) {
        if (override.get(move.threadId) ?? move.accepted) continue;
        this.deps.service.keep(move.threadId, move.from);
        if (move.key)
          this.deps.db
            .prepare(
              `INSERT INTO ws_snooze (key, evidence_count, at) VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET evidence_count = excluded.evidence_count, at = excluded.at`,
            )
            .run(snoozeKey(move.key), move.evidenceCount ?? 1, this.now());
      }
      setMeta(this.deps.db, "bootstrapped", "1");
      state = this.save({
        ...state,
        status: "applied",
        entryId: entry?.id ?? null,
        error: skipped.length
          ? `${skipped.length} thread(s) changed since the preview and were left alone.`
          : null,
        seconds: { ...state.seconds, apply: (this.now() - started) / 1000 },
      });
      return state;
    } catch (error) {
      return this.save({ ...state, status: "failed", error: String(error) });
    }
  }

  /** Turns on evolution without reorganizing anything. */
  skip(): void {
    setMeta(this.deps.db, "bootstrapped", "1");
    this.deps.db.prepare("DELETE FROM ws_meta WHERE key = ?").run(KEY);
    this.deps.onChange();
  }

  cancel(): void {
    if (this.running)
      throw new UserError("Wait for the current step to finish.");
    this.deps.db.prepare("DELETE FROM ws_meta WHERE key = ?").run(KEY);
    this.deps.onChange();
  }

  /** Step 1: every visible root, with who filed it. */
  private intake(): BootstrapState["roots"] {
    const threads = this.deps.service.threads();
    const forest = buildForest(threads);
    const v1Auto = this.v1AutoFilings();
    const placements = this.deps.service.state().placements;
    const names = new Map(
      this.deps.map.list().map((r) => [r.sectionId, r.name.toLowerCase()]),
    );
    const v1Filed = (threadId: string, sectionId: string) => {
      const filing = v1Auto.get(threadId);
      if (!filing) return false;
      // Older v1 entries recorded only the section name.
      return filing.sectionId
        ? filing.sectionId === sectionId
        : filing.name === names.get(sectionId);
    };
    return forest.roots.map(({ thread }) => {
      const placement = placements[thread.id];
      const provenance: Provenance = !thread.sectionId
        ? "unfiled"
        : placement && placement.sectionId === thread.sectionId
          ? placement.source === "auto" ||
            placement.source === "proposal" ||
            placement.source === "bootstrap"
            ? "auto"
            : "user"
          : v1Filed(thread.id, thread.sectionId)
            ? "auto"
            : "user";
      return {
        id: thread.id,
        title: thread.title,
        sectionId: thread.sectionId,
        provenance,
      };
    });
  }

  /**
   * Sections v1 filed automatically, by thread: the latest applied section
   * change in v1's organize log. v1's table is read here and nowhere else.
   */
  private v1AutoFilings(): Map<
    string,
    { sectionId: string | null; name: string }
  > {
    const out = new Map<string, { sectionId: string | null; name: string }>();
    try {
      const row = this.deps.db
        .prepare("SELECT value FROM state WHERE key = 'organize-log'")
        .get() as { value: string } | undefined;
      if (!row) return out;
      const log = JSON.parse(row.value) as {
        action?: { kind?: string; threadId?: string; section?: string };
        result?: string;
        undone?: boolean;
        undo?: { workstreamsSectionId?: string | null };
      }[];
      for (const entry of log) {
        if (
          entry.action?.kind !== "section" ||
          entry.result !== "done" ||
          entry.undone ||
          !entry.action.threadId
        )
          continue;
        out.set(entry.action.threadId, {
          sectionId: entry.undo?.workstreamsSectionId ?? null,
          name: (entry.action.section ?? "").toLowerCase(),
        });
      }
    } catch {
      // No v1 data on this install.
    }
    return out;
  }
}
