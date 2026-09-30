/**
 * Routes new work (SPEC §6) for every entry point: the native composer
 * banner, ＋ New, `bb workstreams new`, and `bb workstreams handoff`.
 *
 * `route` decides and never changes anything; `execute` acts on a decision
 * and journals it. Each decision is remembered briefly by id and by prompt, so
 * a thread the native composer creates with that prompt can be filed where
 * the preview said.
 */
import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isCurrent } from "../domain/analysis.ts";
import { relativeAge } from "../domain/presentation.ts";
import { mentionedTarget, type RouteInput } from "../domain/router.ts";
import { buildForest } from "../domain/tree.ts";
import type { Analyzer } from "./analyzer.ts";
import type { Journal } from "./journal.ts";
import type { WorkstreamMap } from "./map.ts";
import type { Inference } from "./model.ts";
import { UserError, type WorkstreamService } from "./service.ts";

type Sdk = BbPluginApi["sdk"];
type SpawnArgs = Parameters<Sdk["threads"]["spawn"]>[0];
export type Environment = NonNullable<SpawnArgs["environment"]>;

export type Placement = {
  projectId: string;
  environment: Environment;
  /** "checkout", "worktree", or "personal workspace". */
  label: string;
};

type Base = {
  id: string;
  confidence: "high" | "medium" | "low";
  reason: string;
  subject: string | null;
  /**
   * The debug trace of the routing call (SPEC §11.6); null when no model was
   * asked (a mention, a chosen workstream) or debug mode is off.
   */
  traceId: string | null;
};

export type RouteDecision =
  | (Base & {
      outcome: "continue";
      threadId: string;
      threadTitle: string;
      workstream: string | null;
      /** The target thread's workstream; callers that can't continue fall back to it. */
      sectionId: string | null;
    })
  | (Base & {
      outcome: "new-thread";
      sectionId: string;
      workstream: string;
      title: string;
      placement: Placement;
    })
  | (Base & {
      outcome: "new-workstream";
      name: string;
      description: string;
      title: string;
      placement: Placement;
    })
  | (Base & {
      outcome: "unsure";
      candidates: (
        | { kind: "thread"; threadId: string; title: string }
        | { kind: "workstream"; sectionId: string; name: string }
      )[];
    });

export type RouteSource = "router" | "handoff";

const MEMORY_MS = 15 * 60_000;

const hash = (text: string) =>
  createHash("sha256").update(text.trim()).digest("hex");

export class Router {
  private readonly decisions = new Map<
    string,
    { decision: RouteDecision; prompt: string; at: number; used: boolean }
  >();
  private personal: string | null = null;

  constructor(
    private readonly deps: {
      sdk: () => Sdk;
      service: WorkstreamService;
      journal: Journal;
      map: WorkstreamMap;
      analyzer: Analyzer;
      inference: Inference;
      model: () => Promise<string>;
      homeProjectId: () => Promise<string>;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** Decides where `prompt` goes. Changes nothing. */
  async route(
    prompt: string,
    options: {
      pickedProjectId?: string | null;
      /** Threads that can't be the target (the caller, a rejected candidate). */
      exclude?: string | readonly string[] | null;
      /** A workstream the user already chose; skips the model. */
      workstreamId?: string | null;
      /** The unsure decision `workstreamId` was picked from; keeps its trace. */
      fromDecisionId?: string | null;
      /** The thread asking (a handoff's caller), for its debug trace. */
      about?: string | null;
    } = {},
  ): Promise<RouteDecision> {
    const text = prompt.trim();
    if (!text) throw new UserError("Describe the work first.");
    const records = this.deps.map.list();
    const threads = this.deps.service.threads();
    const analysis = this.deps.analyzer.all();
    const forest = buildForest(threads);
    const nameOf = new Map(records.map((r) => [r.sectionId, r.name]));
    const now = this.now();
    const excluded = new Set(
      options.exclude == null ? [] : [options.exclude].flat(),
    );
    const tasks = forest.roots
      .map(({ thread }) => thread)
      .filter((t) => !excluded.has(t.id))
      .sort((a, b) => b.latestAttentionAt - a.latestAttentionAt);

    if (options.workstreamId && !nameOf.has(options.workstreamId))
      throw new UserError(
        "That workstream no longer exists. Choose another workstream.",
      );
    const mention = options.workstreamId
      ? { sectionId: options.workstreamId }
      : mentionedTarget(text);
    if (mention && "threadId" in mention) {
      const target = threads.find((t) => t.id === mention.threadId);
      if (target && !excluded.has(target.id))
        return this.remember(text, {
          id: randomUUID(),
          outcome: "continue",
          threadId: target.id,
          threadTitle: target.title,
          workstream: target.sectionId
            ? (nameOf.get(target.sectionId) ?? null)
            : null,
          sectionId: target.sectionId,
          confidence: "high",
          reason: "The request mentions this thread.",
          subject: null,
          traceId: null,
        });
    }
    if (mention && "sectionId" in mention && nameOf.has(mention.sectionId))
      return this.remember(text, {
        id: randomUUID(),
        outcome: "new-thread",
        sectionId: mention.sectionId,
        workstream: nameOf.get(mention.sectionId)!,
        title: "",
        placement: await this.placement(
          mention.sectionId,
          true,
          options.pickedProjectId,
        ),
        confidence: "high",
        reason: "The request mentions this workstream.",
        subject: null,
        traceId: options.fromDecisionId
          ? (this.byId(options.fromDecisionId)?.traceId ?? null)
          : null,
      });

    const picked = options.pickedProjectId ?? null;
    const input: RouteInput = {
      prompt: text,
      workstreams: records
        .filter((r) => r.evidence.threadCount > 0 || r.description)
        .map((r) => ({
          name: r.name,
          description: r.description,
          subjects: r.subjects,
        })),
      threads: tasks.map((t) => {
        const a = analysis[t.id];
        const current = isCurrent(a, t);
        return {
          id: t.id,
          title: t.title,
          workstream: t.sectionId ? (nameOf.get(t.sectionId) ?? null) : null,
          recap: a?.recap ?? null,
          state: current ? a.state : null,
          age: relativeAge(t.latestAttentionAt, now),
        };
      }),
      pickedProjectHosts:
        picked && picked !== (await this.personalProjectId())
          ? records
              .filter((r) => r.projects.some((p) => p.projectId === picked))
              .map((r) => r.name)
          : null,
    };
    const { value: raw, traceId } = await this.deps.inference.run(
      "route",
      input,
      {
        model: await this.deps.model(),
        label: text.replace(/\s+/g, " "),
        links: options.about ? [{ kind: "thread", ref: options.about }] : [],
      },
    );
    const idOf = new Map(records.map((r) => [r.name, r.sectionId]));
    const titleOf = new Map(threads.map((t) => [t.id, t]));
    const base = {
      id: randomUUID(),
      confidence: "low" as const,
      reason: "",
      subject: null,
      traceId,
    };
    let decision: RouteDecision;
    if (raw.outcome === "continue") {
      const target = titleOf.get(raw.threadId)!;
      decision = {
        ...base,
        ...raw,
        threadTitle: target.title,
        workstream: target.sectionId
          ? (nameOf.get(target.sectionId) ?? null)
          : null,
        sectionId: target.sectionId,
      };
    } else if (
      raw.outcome === "new-workstream" &&
      records.some((r) => r.name.toLowerCase() === raw.name.toLowerCase())
    ) {
      // A workstream with that name exists but wasn't offered (no threads
      // yet): start the thread there rather than creating a duplicate.
      const record = records.find(
        (r) => r.name.toLowerCase() === raw.name.toLowerCase(),
      )!;
      decision = {
        ...base,
        outcome: "new-thread",
        sectionId: record.sectionId,
        workstream: record.name,
        title: raw.title,
        confidence: raw.confidence,
        reason: raw.reason,
        subject: raw.subject,
        placement: await this.placement(record.sectionId, raw.code, picked),
      };
    } else if (raw.outcome === "new-thread") {
      const sectionId = idOf.get(raw.workstream)!;
      decision = {
        ...base,
        ...raw,
        sectionId,
        placement: await this.placement(sectionId, raw.code, picked),
      };
    } else if (raw.outcome === "new-workstream") {
      const like = raw.projectLike ? idOf.get(raw.projectLike) : undefined;
      decision = {
        ...base,
        outcome: "new-workstream",
        name: raw.name,
        description: raw.description,
        title: raw.title,
        confidence: raw.confidence,
        reason: raw.reason,
        subject: raw.subject,
        placement: await this.placement(like ?? null, raw.code, picked),
      };
    } else
      decision = {
        ...base,
        outcome: "unsure",
        reason: raw.reason,
        candidates: raw.candidates.map((c) =>
          "threadId" in c
            ? {
                kind: "thread" as const,
                threadId: c.threadId,
                title: titleOf.get(c.threadId)!.title,
              }
            : {
                kind: "workstream" as const,
                sectionId: idOf.get(c.workstream)!,
                name: c.workstream,
              },
        ),
      };
    this.deps.inference.annotate(traceId, {
      decision: { ...decision, traceId: undefined },
    });
    return this.remember(text, decision);
  }

  /** A remembered decision, by id or by the prompt it was made for. */
  recall(options: {
    id?: string | null;
    prompt: string;
  }): RouteDecision | null {
    this.prune();
    const key = hash(options.prompt);
    // A decision only covers the exact text it was made for.
    if (options.id) {
      const found = this.decisions.get(options.id);
      return found && !found.used && hash(found.prompt) === key
        ? found.decision
        : null;
    }
    const match = [...this.decisions.values()]
      .filter((d) => !d.used && hash(d.prompt) === key)
      .sort((a, b) => b.at - a.at)[0];
    return match?.decision ?? null;
  }

  /** A remembered decision by id, for callers that pass their own prompt. */
  byId(id: string): RouteDecision | null {
    this.prune();
    return this.decisions.get(id)?.decision ?? null;
  }

  /** Stops a decision from filing anything later (dry runs, superseded routes). */
  forget(id: string): void {
    this.decisions.delete(id);
  }

  /**
   * Acts on a decision: sends to the thread, or spawns a filed thread (and
   * its workstream first, for a new one). Unsure decisions change nothing.
   */
  async execute(
    decision: RouteDecision,
    prompt: string,
    source: RouteSource,
    options: {
      /** Text actually sent; handoffs prefix their provenance. */
      message?: string;
      spawnedFrom?: string | null;
      /** Execution choices from the composer the user saw. */
      execution?: Partial<SpawnArgs>;
    } = {},
  ): Promise<{ threadId: string | null; sectionId: string | null }> {
    const sdk = this.deps.sdk();
    const text = options.message ?? prompt;
    const entry = this.decisions.get(decision.id);
    if (entry) entry.used = true;
    if (decision.outcome === "unsure")
      return { threadId: null, sectionId: null };
    if (decision.outcome === "continue") {
      await sdk.threads.send({
        threadId: decision.threadId,
        input: options.execution?.input ?? [
          { type: "text", text, mentions: [] },
        ],
        mode: "queue-if-active",
      });
      const logged = this.deps.journal.add({
        action: "route",
        source,
        rationale: `Sent to ${decision.threadTitle}: ${decision.reason}`,
        threads: [{ id: decision.threadId, name: decision.threadTitle }],
        workstreams: [],
        undo: null,
      });
      this.deps.inference.link(
        decision.traceId,
        { kind: "thread", ref: decision.threadId },
        { kind: "entry", ref: logged.id },
      );
      return { threadId: decision.threadId, sectionId: null };
    }
    let sectionId: string;
    if (decision.outcome === "new-workstream") {
      const created = await this.deps.service.createWorkstream(
        decision.name,
        source,
      );
      sectionId = created.sectionId;
      if (decision.description)
        this.deps.map.describe(sectionId, decision.description);
    } else sectionId = decision.sectionId;
    const at = this.now();
    // The composer's own input keeps attachments and mentions; otherwise send
    // the text.
    const body =
      options.execution &&
      "input" in options.execution &&
      options.execution.input
        ? { input: options.execution.input }
        : { prompt: text };
    const thread = await withRetry(() =>
      sdk.threads.spawn({
        ...options.execution,
        ...body,
        projectId: decision.placement.projectId,
        environment:
          options.execution?.projectId === decision.placement.projectId
            ? (options.execution.environment ?? decision.placement.environment)
            : decision.placement.environment,
        sectionId,
        pluginMetadata: {
          kind: "task",
          workstreamAtCreation: sectionId,
          filedBy: source,
          filedAt: at,
          filedSectionId: sectionId,
          ...(options.spawnedFrom ? { spawnedFrom: options.spawnedFrom } : {}),
        },
      } as SpawnArgs),
    );
    const logged = this.deps.service.recordCreated(
      thread.id,
      sectionId,
      source,
      {
        title: decision.title || thread.title || "New thread",
        rationale:
          decision.outcome === "new-workstream"
            ? `Started in new workstream ${decision.name}: ${decision.reason}`
            : `Started in ${decision.workstream}: ${decision.reason}`,
      },
    );
    this.deps.inference.link(
      decision.traceId,
      { kind: "thread", ref: thread.id },
      { kind: "entry", ref: logged.id },
      ...(decision.outcome === "new-workstream"
        ? [{ kind: "section" as const, ref: sectionId }]
        : []),
    );
    return { threadId: thread.id, sectionId };
  }

  /**
   * Files a thread the native composer just created, per the preview the user
   * saw. Handles a composer thread only once.
   */
  async fileComposed(threadId: string, decision: RouteDecision): Promise<void> {
    const entry = this.decisions.get(decision.id);
    if (entry) entry.used = true;
    let sectionId: string | null = null;
    if (decision.outcome === "new-thread") sectionId = decision.sectionId;
    else if (decision.outcome === "new-workstream") {
      const created = await this.deps.service.createWorkstream(
        decision.name,
        "router",
      );
      sectionId = created.sectionId;
      if (decision.description)
        this.deps.map.describe(sectionId, decision.description);
    } else if (decision.outcome === "continue") {
      // The user started a new thread instead: keep it with that thread's work.
      const target = this.deps.service
        .threads()
        .find((t) => t.id === decision.threadId);
      sectionId = target?.sectionId ?? null;
    }
    this.deps.inference.link(decision.traceId, {
      kind: "thread",
      ref: threadId,
    });
    if (decision.outcome === "new-workstream" && sectionId)
      this.deps.inference.link(decision.traceId, {
        kind: "section",
        ref: sectionId,
      });
    // Only if it is still unfiled: a filing the user made meanwhile wins.
    if (!sectionId) return;
    const logged = await this.deps.service.fileIfUnsorted(
      threadId,
      sectionId,
      "router",
    );
    if (logged)
      this.deps.inference.link(decision.traceId, {
        kind: "entry",
        ref: logged.id,
      });
  }

  /**
   * Project and environment for new work (SPEC §6 policy, I4: always
   * explicit, never `project-default`). The host is the project's default
   * source machine, so the composer can apply the selection as-is.
   */
  private async placement(
    sectionId: string | null,
    code: boolean,
    picked: string | null | undefined,
  ): Promise<Placement> {
    const personal = await this.personalProjectId();
    const projects = sectionId
      ? (this.deps.map.get(sectionId)?.projects ?? [])
      : [];
    if (picked) {
      const configured = projects.find((p) => p.projectId === picked);
      return this.on(
        picked,
        picked === personal
          ? "personal workspace"
          : configured?.environment === "worktree"
            ? "worktree"
            : "checkout",
      );
    }
    if (code) {
      const chosen = projects.find((p) => p.role === "primary");
      if (chosen)
        return this.on(
          chosen.projectId,
          chosen.environment === "worktree" ? "worktree" : "checkout",
        );
    }
    const home = (await this.deps.homeProjectId()).trim();
    if (home) return this.on(home, "checkout");
    return this.on(personal, "personal workspace");
  }

  private async on(
    projectId: string,
    label: "checkout" | "worktree" | "personal workspace",
  ): Promise<Placement> {
    const hostId = await this.hostFor(projectId);
    const workspace =
      label === "worktree"
        ? {
            type: "managed-worktree" as const,
            baseBranch: { kind: "default" as const },
          }
        : label === "personal workspace"
          ? { type: "personal" as const }
          : { type: "unmanaged" as const, path: null };
    return {
      projectId,
      label,
      environment: {
        type: "host",
        ...(hostId ? { hostId } : {}),
        workspace,
      } as Environment,
    };
  }

  private async hostFor(projectId: string): Promise<string | null> {
    const sdk = this.deps.sdk();
    try {
      const projects = await sdk.projects.list({
        includePersonal: true,
      } as never);
      const project = (
        projects as {
          id: string;
          sources?: { hostId: string; isDefault?: boolean }[];
        }[]
      ).find((p) => p.id === projectId);
      const source =
        project?.sources?.find((s) => s.isDefault) ?? project?.sources?.[0];
      if (source) return source.hostId;
    } catch {
      // Fall back to the only connected machine.
    }
    const hosts = (await sdk.hosts.list()).filter(
      (h) => h.status === "connected",
    );
    return hosts.length === 1 ? hosts[0]!.id : null;
  }

  private async personalProjectId(): Promise<string> {
    if (this.personal) return this.personal;
    const bootstrap = await this.deps.sdk().projects.sidebarBootstrap();
    this.personal = bootstrap.personalProject.id;
    return this.personal;
  }

  private remember(prompt: string, decision: RouteDecision): RouteDecision {
    this.prune();
    this.decisions.set(decision.id, {
      decision,
      prompt,
      at: this.now(),
      used: false,
    });
    return decision;
  }

  private prune() {
    const cutoff = this.now() - MEMORY_MS;
    for (const [id, d] of this.decisions)
      if (d.at < cutoff) this.decisions.delete(id);
  }
}

/** Retries a spawn while BB answers 5xx, e.g. a parent still starting (S5). */
async function withRetry<T>(work: () => Promise<T>, attempts = 4): Promise<T> {
  let delay = 400;
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const status = (error as { status?: number }).status ?? 0;
      if (attempt >= attempts || status < 500) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}
