import { createHash } from "node:crypto";
import { buildForest, flatten } from "../domain/tree.ts";
import { isCurrent } from "../domain/analysis.ts";
import type { ModelChoice } from "../domain/prefs.ts";
import type { OrganizeInput, OrganizeProposal } from "../domain/organize.ts";
import type { Analyzer } from "./analyzer.ts";
import {
  cleanupCandidate,
  type CleanupCandidate,
  type CleanupMember,
} from "./cleanup.ts";
import { getMeta, setMeta, type Database } from "./db.ts";
import type { WorkstreamMap } from "./map.ts";
import type { CorpusStore } from "./corpus.ts";
import { activeHome } from "../domain/regroup.ts";
import { corpusLabel } from "../domain/corpus-label.ts";
import { traceIdOf, type Inference } from "./model.ts";
import {
  UserError,
  type BatchPlan,
  type WorkstreamService,
} from "./service.ts";

export type BootstrapMove = {
  threadId: string;
  title: string;
  from: string | null;
  fromName: string;
  to: string | null;
  toName: string;
  reason: string;
  accepted: boolean;
};
export type BootstrapState = {
  status: "proposing" | "preview" | "applying" | "applied" | "failed";
  startedAt: number;
  updatedAt: number;
  error: string | null;
  progress?: {
    stage: "classifying" | "regrouping";
    completed: number;
    total: number;
    cached: number;
    unresolved: number;
  };
  roots: { id: string; title: string; sectionId: string | null }[];
  mapSnapshot: {
    sectionId: string;
    name: string;
    description: string | null;
    aliases: string[];
    descriptionSource: "user" | "generated";
  }[];
  preview: {
    workstreams: OrganizeProposal["workstreams"];
    creates: { name: string; description: string }[];
    renames: { sectionId: string; from: string; to: string }[];
    moves: BootstrapMove[];
    assignments: OrganizeProposal["assignments"];
    removals: CleanupCandidate[];
  } | null;
  entryId: string | null;
  traceIds: string[];
};
const KEY = "organizer";
const newKey = (key: string) => `new:${key}`;

/** One snapshot and one completion produce a preview; only Apply mutates BB. */
export class Bootstrap {
  private running = false;
  private controller: AbortController | null = null;
  private disposed = false;
  constructor(
    private readonly deps: {
      db: Database;
      service: WorkstreamService;
      analyzer: Analyzer;
      map: WorkstreamMap;
      corpus?: CorpusStore;
      adaptive?: () => boolean;
      policy?: () => { capacity: number; collapseAt: number };
      inference: Inference;
      model: () => Promise<ModelChoice>;
      classificationModel?: () => Promise<ModelChoice>;
      projects?: () => Promise<{ id: string; name: string }[]>;
      requests?: (threadId: string) => Promise<string[]>;
      members: (sectionId: string) => Promise<CleanupMember[]>;
      onChange: () => void;
      now?: () => number;
    },
  ) {
    const state = this.state();
    if (state && (state.status === "proposing" || state.status === "applying"))
      this.save({
        ...state,
        status: "failed",
        error:
          "Organizing was interrupted. Review Activity for any applied changes before starting again.",
      });
  }
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  isDone() {
    return getMeta(this.deps.db, "bootstrapped") === "1";
  }
  state(): BootstrapState | null {
    const raw = getMeta(this.deps.db, KEY);
    const state = raw ? (JSON.parse(raw) as BootstrapState) : null;
    // An older saved preview has no reviewed cleanup plan; regenerate it.
    if (state?.preview && !Array.isArray(state.preview.removals)) return null;
    return state;
  }
  private save(state: BootstrapState) {
    const next = { ...state, updatedAt: this.now() };
    setMeta(this.deps.db, KEY, JSON.stringify(next));
    this.deps.onChange();
    return next;
  }
  resetCatalog(): void {
    if (this.running)
      throw new UserError(
        "Cancel and wait for Organize before resetting the Catalog.",
      );
    if (!this.deps.corpus) throw new UserError("Catalog is unavailable.");
    this.deps.corpus.reset();
    setMeta(this.deps.db, KEY, "");
    this.deps.onChange();
  }

  dispose() {
    this.disposed = true;
    this.controller?.abort();
  }
  async start(): Promise<BootstrapState> {
    if (this.running || this.disposed)
      throw new UserError("Organizing is already running or unavailable.");
    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    const startedAt = Math.max(this.now(), (this.state()?.startedAt ?? 0) + 1);
    let state: BootstrapState = this.save({
      status: "proposing",
      startedAt,
      updatedAt: startedAt,
      error: null,
      roots: [],
      mapSnapshot: [],
      preview: null,
      entryId: null,
      traceIds: [],
    });
    try {
      await this.deps.service.reconcile();
      const threads = this.deps.service.threads();
      this.deps.map.refresh(threads, this.deps.analyzer.all());
      const roots = buildForest(threads).roots;
      const records = this.deps.map.list();
      const projects = new Map(
        ((await this.deps.projects?.()) ?? []).map((p) => [p.id, p.name]),
      );
      const analysis = this.deps.analyzer.all();
      const input: OrganizeInput = {
        workstreams: records.map((r) => ({
          id: r.sectionId,
          name: r.name,
          description: r.description,
          aliases: r.aliases,
        })),
        threads: roots.map((root) => ({
          id: root.thread.id,
          title: root.thread.title,
          sectionId: root.thread.sectionId ?? null,
          project: projects.get(root.thread.projectId) ?? null,
          recap: analysis[root.thread.id]?.recap ?? null,
          subject: analysis[root.thread.id]?.subject ?? null,
          children: flatten(root)
            .slice(1)
            .map((n) => n.thread.title),
        })),
      };
      if (controller.signal.aborted || this.disposed)
        throw new Error("Organizing cancelled.");
      state = this.save({
        ...state,
        mapSnapshot: records.map((r) => ({
          sectionId: r.sectionId,
          name: r.name,
          description: r.description,
          aliases: r.aliases,
          descriptionSource: r.descriptionSource,
        })),
        roots: input.threads.map((t) => ({
          id: t.id,
          title: t.title,
          sectionId: t.sectionId,
        })),
      });
      if (controller.signal.aborted || this.disposed)
        throw new Error("Organizing cancelled.");
      const result =
        this.deps.corpus && this.deps.adaptive?.()
          ? await this.compact(input, controller.signal, startedAt)
          : input.threads.length
            ? await this.deps.inference.run("organize", input, {
                model: await this.deps.model(),
                signal: controller.signal,
                label: `${roots.length} root threads`,
                links: [this.runLink(startedAt)],
              })
            : {
                value: { workstreams: [], assignments: [] } as OrganizeProposal,
                traceId: null,
              };
      if (controller.signal.aborted || this.disposed)
        throw new Error("Organizing cancelled.");
      const proposal = result.value;
      for (const home of proposal.workstreams) {
        const existing = records.find((r) => r.sectionId === home.sectionId);
        if (existing?.descriptionSource === "user")
          home.description = existing.description ?? "";
      }
      const byKey = new Map(proposal.workstreams.map((w) => [w.key, w]));
      const byId = new Map(input.threads.map((t) => [t.id, t]));
      const names = new Map(records.map((r) => [r.sectionId, r.name]));
      const moves = proposal.assignments.flatMap((a) => {
        const root = byId.get(a.threadId)!;
        const target = a.workstream === null ? null : byKey.get(a.workstream)!;
        const to = target ? (target.sectionId ?? newKey(target.key)) : null;
        return to === root.sectionId
          ? []
          : [
              {
                threadId: root.id,
                title: root.title,
                from: root.sectionId,
                fromName: names.get(root.sectionId ?? "") ?? "Unfiled",
                to,
                toName: target?.name ?? "Unfiled",
                reason: a.reason,
                accepted: true,
              },
            ];
      });
      const destinations = new Set(
        proposal.workstreams.flatMap((w) => (w.sectionId ? [w.sectionId] : [])),
      );
      const movingAway = new Set(moves.map((m) => m.threadId));
      const removals: CleanupCandidate[] = [];
      for (const record of records) {
        if (destinations.has(record.sectionId)) continue;
        if (controller.signal.aborted || this.disposed)
          throw new Error("Organizing cancelled.");
        const members = await this.deps.members(record.sectionId);
        const candidate = cleanupCandidate(
          { id: record.sectionId, name: record.name },
          members,
          this.now(),
          movingAway,
        );
        if (candidate) removals.push(candidate);
      }
      if (controller.signal.aborted || this.disposed)
        throw new Error("Organizing cancelled.");
      return this.save({
        ...state,
        status: "preview",
        progress: this.state()?.progress,
        traceIds: result.traceId ? [result.traceId] : [],
        preview: {
          workstreams: proposal.workstreams,
          creates: proposal.workstreams
            .filter((w) => w.sectionId === null)
            .map((w) => ({ name: w.name, description: w.description })),
          renames: proposal.workstreams.flatMap((w) =>
            w.sectionId && names.get(w.sectionId) !== w.name
              ? [
                  {
                    sectionId: w.sectionId,
                    from: names.get(w.sectionId)!,
                    to: w.name,
                  },
                ]
              : [],
          ),
          moves,
          assignments: proposal.assignments,
          removals,
        },
      });
    } catch (error) {
      if (controller.signal.aborted || this.disposed)
        return { ...state, status: "failed", error: "Organizing cancelled." };
      const trace = traceIdOf(error);
      return this.save({
        ...state,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        traceIds: trace ? [trace] : [],
      });
    } finally {
      this.running = false;
      this.controller = null;
    }
  }
  private async compact(
    input: OrganizeInput,
    signal: AbortSignal,
    startedAt: number,
  ) {
    const corpus = this.deps.corpus!;
    corpus.syncGroups(
      this.deps.map
        .list()
        .map((r) => ({ ...r, description: r.description ?? "" })),
    );
    const model = await this.deps.model();
    const catalogVersion = "catalog-semantics-v1";
    const subjects = corpus.subjects();
    const requestsById = new Map<string, string[]>();
    let requestCursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, input.threads.length) }, async () => {
        while (!signal.aborted && requestCursor < input.threads.length) {
          const thread = input.threads[requestCursor++]!;
          requestsById.set(
            thread.id,
            (await this.deps.requests?.(thread.id)) ?? [],
          );
        }
      }),
    );
    if (signal.aborted) throw new Error("Organizing cancelled.");
    const evidence = new Map(
      input.threads.map((thread) => [
        thread.id,
        createHash("sha256")
          .update(
            JSON.stringify({
              version: catalogVersion,
              requests: requestsById.get(thread.id),
              title: thread.title,
              project: thread.project,
            }),
          )
          .digest("hex"),
      ]),
    );
    const pending = input.threads.filter(
      (thread) => !corpus.isFresh(thread.id, evidence.get(thread.id)!),
    );
    const cached = input.threads.length - pending.length;
    let completed = 0;
    let unresolved = 0;
    let cursor = 0;
    const publish = (stage: "classifying" | "regrouping") => {
      const current = this.state();
      if (
        !signal.aborted &&
        current?.startedAt === startedAt &&
        current.status === "proposing"
      )
        this.save({
          ...current,
          progress: {
            stage,
            completed,
            total: pending.length,
            cached,
            unresolved,
          },
        });
    };
    const classificationModel = pending.length
      ? await (this.deps.classificationModel?.() ?? Promise.resolve(model))
      : model;
    publish("classifying");
    let failure: unknown;
    const worker = async () => {
      while (!signal.aborted && !failure && cursor < pending.length) {
        const thread = pending[cursor++]!;
        try {
          const requests = requestsById.get(thread.id);
          if (signal.aborted) return;
          const { value } = await this.deps.inference.run(
            "classify",
            {
              prompt: `${thread.title}\n${thread.recap ?? ""}`,
              entities: corpus.list(),
              project: thread.project,
              requests,
            },
            {
              model: classificationModel,
              signal,
              threadId: thread.id,
              label: thread.title,
            },
          );
          if (signal.aborted) return;
          const entity = value.subjectId
            ? corpus.list().find((e) => e.id === value.subjectId)
            : value.proposed
              ? corpus.rememberProposal(value.proposed)
              : null;
          if (entity) {
            corpus.assign(thread.id, entity.id, evidence.get(thread.id)!);
            subjects.set(thread.id, entity.id);
          } else {
            corpus.unassign(thread.id);
            subjects.delete(thread.id);
            unresolved++;
          }
          completed++;
          publish("classifying");
        } catch (error) {
          failure ??= error;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(3, pending.length) }, worker),
    );
    if (signal.aborted) throw new Error("Organizing cancelled.");
    if (failure) throw failure;
    publish("regrouping");
    corpus.syncGroups(
      input.workstreams.map((w) => ({
        sectionId: w.id,
        name: w.name,
        description: w.description ?? "",
        aliases: w.aliases,
      })),
    );
    const entities = corpus.list();
    const counts: Record<string, number> = {};
    const analysis = this.deps.analyzer.all();
    for (const thread of input.threads) {
      const id = subjects.get(thread.id);
      const live = this.deps.service.threads().find((t) => t.id === thread.id);
      const assessment = analysis[thread.id];
      if (
        id &&
        !(live && isCurrent(assessment, live) && assessment?.state === "done")
      )
        counts[id] = (counts[id] ?? 0) + 1;
    }
    const links = corpus.groups();
    const active = [
      ...new Set(
        input.workstreams.flatMap((w) =>
          links.has(w.id) ? [links.get(w.id)!] : [],
        ),
      ),
    ];
    const { value, traceId } = await this.deps.inference.run(
      "regroup",
      {
        entities,
        counts,
        active,
        ...(this.deps.policy?.() ?? { capacity: 6, collapseAt: 3 }),
      },
      {
        model,
        signal,
        label: "Concurrent subject groups",
        links: [this.runLink(startedAt)],
      },
    );
    if (signal.aborted) throw new Error("Organizing cancelled.");
    const selected = value.activeEntityIds;
    const label = (id: string) => corpusLabel(id, entities);
    const workstreams: OrganizeProposal["workstreams"] = selected.map((id) => {
      const existing = input.workstreams.find((w) => links.get(w.id) === id);
      const entity = entities.find((e) => e.id === id)!;
      return {
        key: id,
        sectionId: existing?.id ?? null,
        name: label(id),
        description: entity.description ?? `Work concerning ${label(id)}`,
        aliases: [...entity.aliases],
      };
    });
    if (
      new Set(workstreams.map((w) => w.name.toLowerCase())).size !==
      workstreams.length
    )
      throw new UserError(
        "Corpus labels collide. Resolve the identities before applying groups.",
      );
    for (const home of workstreams) {
      if (
        !home.sectionId &&
        input.workstreams.some(
          (w) => w.name.toLowerCase() === home.name.toLowerCase(),
        )
      )
        throw new UserError(
          "A proposed group name belongs to a different identity.",
        );
    }
    const assignments = input.threads.map((t) => {
      const id = subjects.get(t.id);
      const target = id ? activeHome(id, selected, entities) : null;
      // Completed or unresolved roots retain a home rather than disappearing from navigation.
      let key = target;
      if (!key && t.sectionId) {
        const existing = input.workstreams.find((w) => w.id === t.sectionId);
        if (existing) {
          key =
            workstreams.find((w) => w.sectionId === existing.id)?.key ??
            `retained:${existing.id}`;
          if (!workstreams.some((w) => w.key === key))
            workstreams.push({
              key,
              sectionId: existing.id,
              name: existing.name,
              description: existing.description ?? existing.name,
              aliases: existing.aliases,
            });
        }
      }
      return {
        threadId: t.id,
        workstream: key,
        reason: "Resolved specific subject to current navigation.",
      };
    });
    return {
      value: { workstreams, assignments } satisfies OrganizeProposal,
      traceId,
    };
  }
  async apply(
    overrides: { threadId: string; accepted: boolean }[] = [],
    runId: number,
  ): Promise<BootstrapState> {
    if (this.running || this.disposed)
      throw new UserError("Organizing is already running or unavailable.");
    const current = this.state();
    if (!current || current.status !== "preview" || !current.preview)
      throw new UserError("Nothing to apply yet.");
    if (runId !== current.startedAt)
      throw new UserError(
        "This preview was replaced. Review the current map before applying.",
      );
    const preview = current.preview;
    const allowed = new Set(preview.moves.map((m) => m.threadId));
    if (overrides.some((o) => !allowed.has(o.threadId)))
      throw new UserError("Unknown thread override.");
    this.running = true;
    let state = this.save({ ...current, status: "applying" });
    try {
      const selections = new Map(
        overrides.map((o) => [o.threadId, o.accepted]),
      );
      const moves = preview.moves.filter(
        (m) => selections.get(m.threadId) ?? m.accepted,
      );
      const used = new Set(moves.map((m) => m.to));
      const plan: BatchPlan = {
        creates: preview.workstreams
          .filter((w) => !w.sectionId && used.has(newKey(w.key)))
          .map((w) => ({
            key: newKey(w.key),
            name: w.name,
            description: w.description,
          })),
        renames: preview.renames.map((r) => ({
          sectionId: r.sectionId,
          name: r.to,
          from: r.from,
        })),
        moves: moves.map((m) => ({
          threadId: m.threadId,
          from: m.from,
          to: m.to,
        })),
        metadata: preview.workstreams
          .filter((w) => w.sectionId || used.has(newKey(w.key)))
          .map((w) => ({
            sectionId: w.sectionId ?? newKey(w.key),
            description: w.description,
            aliases: w.aliases,
          })),
        expectedMap: current.mapSnapshot,
        removals: preview.removals,
      };
      const { entry, skipped, cleanupSkipped, created } =
        await this.deps.service.applyBatch(
          plan,
          "bootstrap",
          `Organized ${moves.length} threads`,
        );
      if (entry)
        this.deps.inference.copyLinks(this.runLink(current.startedAt), {
          kind: "entry",
          ref: entry.id,
        });
      if (this.deps.corpus) {
        const entities = this.deps.corpus.list();
        for (const home of preview.workstreams) {
          if (!entities.some((e) => e.id === home.key)) continue;
          const sectionId = home.sectionId ?? created.get(newKey(home.key));
          if (sectionId) this.deps.corpus.bindGroup(sectionId, home.key);
        }
      }
      this.deps.corpus?.syncGroups(
        this.deps.map
          .list()
          .map((r) => ({ ...r, description: r.description ?? "" })),
      );
      this.deps.map.refresh(
        this.deps.service.threads(),
        this.deps.analyzer.all(),
      );
      setMeta(this.deps.db, "bootstrapped", "1");
      state = this.save({
        ...state,
        status: "applied",
        entryId: entry?.id ?? null,
        error:
          [
            skipped.length
              ? `${skipped.length} thread(s) changed since the preview and were left alone.`
              : "",
            cleanupSkipped.length
              ? `${cleanupSkipped.length} workstream(s) no longer qualified for cleanup and were kept.`
              : "",
          ]
            .filter(Boolean)
            .join(" ") || null,
      });
      return state;
    } catch (error) {
      return this.save({
        ...state,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
  cancel() {
    if (this.state()?.status === "applying")
      throw new UserError("Wait for Apply to finish.");
    this.controller?.abort();
    this.deps.db.prepare("DELETE FROM ws_meta WHERE key = ?").run(KEY);
    this.deps.onChange();
  }
  private runLink(startedAt: number) {
    return { kind: "organize" as const, ref: String(startedAt) };
  }
}
