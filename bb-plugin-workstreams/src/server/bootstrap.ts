import { buildForest, flatten } from "../domain/tree.ts";
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
      inference: Inference;
      model: () => Promise<ModelChoice>;
      projects?: () => Promise<{ id: string; name: string }[]>;
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
      const result = input.threads.length
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
      const { entry, skipped, cleanupSkipped } =
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
