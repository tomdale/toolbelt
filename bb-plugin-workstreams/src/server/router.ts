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
import type { ModelChoice } from "../domain/prefs.ts";
import { relativeAge } from "../domain/presentation.ts";
import {
  mentionedTarget,
  type RawRoute,
  type RouteInput,
} from "../domain/router.ts";
import { buildForest } from "../domain/tree.ts";
import type { Analyzer } from "./analyzer.ts";
import type { Journal, Source } from "./journal.ts";
import type { WorkstreamMap } from "./map.ts";
import { type Inference } from "./model.ts";
import { UserError, type WorkstreamService } from "./service.ts";
import type { CorpusStore } from "./corpus.ts";
import { activeHome } from "../domain/regroup.ts";
import { corpusLabel } from "../domain/corpus-label.ts";
import type { DraftSubjectProposal } from "../domain/corpus.ts";

type Sdk = BbPluginApi["sdk"];
type SpawnArgs = Parameters<Sdk["threads"]["spawn"]>[0];
type SendArgs = Parameters<Sdk["threads"]["send"]>[0];
export type Environment = NonNullable<SpawnArgs["environment"]>;

export type Placement = {
  projectId: string;
  environment: Environment;
  label: string;
};

export type RouteIntent = {
  action?: "new-thread" | "send-message" | "new-workstream";
  destination?:
    | { kind: "workstream"; id: string }
    | { kind: "thread"; id: string }
    | { kind: "none" };
  placement?: { projectId?: string; environment?: Environment };
  workstreamName?: string;
};

type Base = {
  id: string;
  confidence: "high" | "medium" | "low";
  reason: string;
  subject: string | null;
  subjectId?: string | null;
  proposal?: DraftSubjectProposal | null;
  /**
   * The debug trace of the routing call (SPEC §11.6); null when no model was
   * asked (a mention, a chosen workstream) or debug mode is off.
   */
  traceId: string | null;
  /**
   * How New work's suggestion was reached, step by step, and how long the
   * route took. Present only on a suggestion routed in Debug mode.
   */
  explanation?: { notes: string[]; durationMs: number };
};

export type NewThreadDecision = Base & {
  outcome: "new-thread";
  sectionId: string | null;
  workstream: string | null;
  title: string;
  placement: Placement | null;
};

export type RouteDecision =
  | (Base & {
      outcome: "continue";
      threadId: string;
      threadTitle: string;
      workstream: string | null;
      /** The target thread's workstream; callers that can't continue fall back to it. */
      sectionId: string | null;
      /**
       * The new thread this work would start instead, present when the caller
       * asked for it with `offerNewThread`. It is remembered as its own
       * decision for the same prompt and intent, so New work can default to it
       * and offer the continuation as a suggestion.
       */
      alternative?: NewThreadDecision;
    })
  | NewThreadDecision
  | (Base & {
      outcome: "new-workstream";
      placement: Placement | null;
      name: string;
      description: string;
      title: string;
    })
  | (Base & {
      outcome: "unsure";
      candidates: (
        | { kind: "thread"; threadId: string; title: string }
        | { kind: "workstream"; sectionId: string; name: string }
      )[];
    });

export type RouteClaim = {
  readonly decision: RouteDecision;
  readonly prompt: string;
  readonly intent: RouteIntent | null;
};

export type RouteSource = "router" | "handoff";

const MEMORY_MS = 15 * 60_000;

/** The `NewThreadRequest` fields `start` forwards to `threads.spawn`. */
const START_FIELDS = [
  "projectId",
  "environment",
  "input",
  "prompt",
  "providerId",
  "model",
  "reasoningLevel",
  "permissionMode",
  "serviceTier",
  "executionInputSources",
  "sendAt",
] as const satisfies readonly (keyof SpawnArgs)[];

const hash = (text: string) =>
  createHash("sha256").update(text.trim()).digest("hex");

export class Router {
  private readonly decisions = new Map<
    string,
    {
      decision: RouteDecision;
      prompt: string;
      intent: RouteIntent | null;
      at: number;
      used: boolean;
    }
  >();
  private readonly claims = new WeakSet<RouteClaim>();
  private personal: string | null = null;

  constructor(
    private readonly deps: {
      sdk: () => Sdk;
      corpus?: CorpusStore;
      semanticSuggestions?: () => boolean;
      service: WorkstreamService;
      journal: Journal;
      map: WorkstreamMap;
      analyzer: Analyzer;
      inference: Inference;
      model: () => Promise<ModelChoice>;
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
      /**
       * The workstream New work's field shows (preset by a workstream's ＋).
       * Unlike `workstreamId` the model is still asked, told to prefer it.
       */
      selectedWorkstreamId?: string | null;
      /** Explicit New-work intent from the focused composer. */
      intent?: RouteIntent | null;
      /**
       * Also preview the new thread an inferred continuation would otherwise
       * start, as the decision's `alternative`. Ignored when the intent fixes
       * the action or destination.
       */
      offerNewThread?: boolean;
      /**
       * New work's suggestion: name the single most likely home, which may
       * be a new workstream, instead of leaving an uncertain choice. Nothing
       * is created until the user accepts it.
       */
      suggest?: boolean;
      /**
       * Receives one plain-language note per deterministic step between the
       * draft and the decision (a mention short-circuit, what the model was
       * offered and answered, each rewrite, how the placement was chosen),
       * for Debug mode.
       */
      explain?: (note: string) => void;
      /** The unsure decision `workstreamId` was picked from; keeps its trace. */
      fromDecisionId?: string | null;
      /** The thread asking (a handoff's caller), for its debug trace. */
      about?: string | null;
      /** Aborts the model call; the route then rejects with the reason. */
      signal?: AbortSignal;
    } = {},
  ): Promise<RouteDecision> {
    const text = prompt.trim();
    if (!text) throw new UserError("Describe the work first.");
    const explain = options.explain ?? (() => {});
    const records = this.deps.map.list();
    const threads = this.deps.service.threads();
    const intent = options.intent ?? null;
    const destination = intent?.destination;
    const explicitProject = intent?.placement?.projectId;
    const explicitEnvironment = intent?.placement?.environment;
    const selectedProject = explicitProject ?? options.pickedProjectId ?? null;
    const offerNewThread =
      !!options.offerNewThread && !intent?.action && !destination;
    const remember = async (decision: RouteDecision) => {
      let constrained = this.constrain(decision, intent);
      if (constrained.outcome === "continue" && offerNewThread)
        constrained = {
          ...constrained,
          alternative: this.remember(
            text,
            await this.newThreadInstead(
              constrained,
              selectedProject,
              explicitEnvironment,
            ),
            intent,
          ),
        };
      return this.remember(text, constrained, intent);
    };
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
    if (
      destination &&
      intent?.action &&
      ((intent.action === "send-message" && destination.kind !== "thread") ||
        (intent.action === "new-thread" && destination.kind === "thread") ||
        intent.action === "new-workstream")
    )
      throw new UserError(
        "That destination is incompatible with the selected action.",
      );
    if (explicitProject) await this.project(explicitProject);
    // Explicit destinations remain authoritative over mentions and inference.
    if (
      (intent?.action === "send-message" ||
        (!intent?.action && destination?.kind === "thread")) &&
      destination
    ) {
      if (destination.kind !== "thread")
        throw new UserError("Choose an existing thread to send a message.");
      const target = threads.find((t) => t.id === destination.id);
      if (!target) throw new UserError("That thread no longer exists.");
      return remember({
        id: randomUUID(),
        outcome: "continue",
        threadId: target.id,
        threadTitle: target.title,
        workstream: target.sectionId
          ? (nameOf.get(target.sectionId) ?? null)
          : null,
        sectionId: target.sectionId,
        confidence: "high",
        reason: "The destination was chosen explicitly.",
        subject: null,
        traceId: null,
      });
    }
    if (
      (!intent?.action || intent.action === "new-thread") &&
      destination?.kind === "none" &&
      selectedProject
    )
      return remember({
        id: randomUUID(),
        outcome: "new-thread",
        sectionId: null,
        workstream: null,
        title: "",
        placement: await this.placement(
          null,
          false,
          selectedProject,
          explicitEnvironment,
          true,
        ),
        confidence: "high",
        reason: "No workstream was chosen explicitly.",
        subject: null,
        traceId: null,
      });
    if (
      (!intent?.action || intent.action === "new-thread") &&
      destination?.kind === "workstream"
    ) {
      if (!nameOf.has(destination.id))
        throw new UserError("That workstream no longer exists.");
      return remember({
        id: randomUUID(),
        outcome: "new-thread",
        sectionId: destination.id,
        workstream: nameOf.get(destination.id)!,
        title: "",
        placement: await this.placement(
          destination.id,
          true,
          selectedProject,
          explicitEnvironment,
          false,
        ),
        confidence: "high",
        reason: "The destination was chosen explicitly.",
        subject: null,
        traceId: null,
      });
    }
    if (intent?.action === "new-workstream" && intent.workstreamName?.trim()) {
      const name = intent.workstreamName.trim();
      return remember({
        id: randomUUID(),
        outcome: "new-workstream",
        name,
        description: "",
        title: "",
        placement: await this.placement(
          null,
          true,
          selectedProject,
          explicitEnvironment,
          true,
        ),
        confidence: "high",
        reason: "The workstream name was chosen explicitly.",
        subject: null,
        traceId: null,
      });
    }
    const mention = options.workstreamId
      ? { sectionId: options.workstreamId }
      : mentionedTarget(text);
    if (
      destination?.kind !== "none" &&
      !(options.suggest && this.deps.semanticSuggestions?.()) &&
      mention &&
      "threadId" in mention &&
      intent?.action !== "new-thread" &&
      intent?.action !== "new-workstream"
    ) {
      const target = threads.find((t) => t.id === mention.threadId);
      if (target && !excluded.has(target.id)) {
        explain(
          `The draft mentions the thread "${target.title}", so the model wasn't asked.`,
        );
        return remember({
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
    }
    if (
      destination?.kind !== "none" &&
      mention &&
      "sectionId" in mention &&
      nameOf.has(mention.sectionId) &&
      intent?.action !== "new-workstream"
    ) {
      explain(
        options.workstreamId
          ? `The workstream "${nameOf.get(mention.sectionId)}" was chosen, so the model wasn't asked.`
          : `The draft mentions the workstream "${nameOf.get(mention.sectionId)}", so the model wasn't asked.`,
      );
      return remember({
        id: randomUUID(),
        outcome: "new-thread",
        sectionId: mention.sectionId,
        workstream: nameOf.get(mention.sectionId)!,
        title: "",
        placement: options.suggest
          ? await this.suggestedPlacement(mention.sectionId, true, explain)
          : await this.placement(
              mention.sectionId,
              true,
              selectedProject,
              explicitEnvironment,
            ),
        confidence: "high",
        reason: "The request mentions this workstream.",
        subject: null,
        traceId: options.fromDecisionId
          ? (this.byId(options.fromDecisionId)?.traceId ?? null)
          : null,
      });
    }

    const picked = selectedProject;
    if (
      options.suggest &&
      this.deps.corpus &&
      this.deps.semanticSuggestions?.()
    ) {
      const corpus = this.deps.corpus;
      corpus.syncGroups(
        records.map((r) => ({ ...r, description: r.description ?? "" })),
      );
      const { value: classification, traceId } = await this.deps.inference.run(
        "classify",
        {
          prompt: text,
          entities: corpus.list(),
          project: selectedProject ?? undefined,
        },
        {
          model: await this.deps.model(),
          signal: options.signal,
          label: text.replace(/\s+/g, " "),
        },
      );
      const existingEntity = classification.subjectId
        ? corpus.getById(classification.subjectId)
        : null;
      const proposed = classification.proposed ?? null;
      if (!existingEntity && !proposed)
        return remember({
          id: randomUUID(),
          outcome: "unsure",
          candidates: [],
          confidence: "low",
          reason: "The subject is not clear enough to classify.",
          subject: null,
          traceId,
        });
      const groups = corpus.groups();
      const current = records.filter((r) => r.evidence.threadCount > 0);
      const activeIds = current.flatMap((r) =>
        groups.has(r.sectionId) ? [groups.get(r.sectionId)!] : [],
      );
      const home = existingEntity
        ? activeHome(existingEntity.id, activeIds, corpus.list())
        : proposed?.parentId
          ? activeHome(proposed.parentId, activeIds, corpus.list())
          : null;
      const record = home
        ? records.find((r) => groups.get(r.sectionId) === home)
        : existingEntity
          ? records.find((r) => groups.get(r.sectionId) === existingEntity.id)
          : null;
      const base = {
        id: randomUUID(),
        confidence: "high" as const,
        reason: "Classified subject independently of current navigation.",
        subject: existingEntity ? existingEntity.name : proposed!.name,
        subjectId: existingEntity ? existingEntity.id : null,
        proposal: proposed ?? null,
        traceId,
      };
      const decision: RouteDecision = record
        ? {
            ...base,
            outcome: "new-thread",
            sectionId: record.sectionId,
            workstream: record.name,
            title: "",
            placement: null,
          }
        : {
            ...base,
            outcome: "new-workstream",
            name: proposed
              ? [
                  proposed.parentId
                    ? corpusLabel(
                        proposed.parentId,
                        corpus.list(),
                      )
                    : null,
                  ...(proposed.ancestors ?? []).map(
                    (a) => a.name,
                  ),
                  proposed.name,
                ]
                  .filter(Boolean)
                  .join(": ")
              : corpusLabel(existingEntity!.id, corpus.list()),
            description: proposed?.description ?? existingEntity?.description ?? "",
            title: "",
            placement: null,
          };
      return remember(decision);
    }
    // A suggestion may name a workstream the user just made, so it sees
    // empty ones too rather than proposing a duplicate.
    const populated = options.suggest
      ? records
      : records.filter((r) => r.evidence.threadCount > 0);
    const input: RouteInput = {
      prompt: text,
      ...(intent?.action === "new-workstream"
        ? { allowNewWorkstream: true }
        : {}),
      ...(options.suggest ? { suggest: true } : {}),
      selectedWorkstream: options.selectedWorkstreamId
        ? (nameOf.get(options.selectedWorkstreamId) ?? null)
        : null,
      workstreams: populated.map((r) => ({
        name: r.name,
        description: r.description,
        subjects: r.subjects,
        aliases: r.aliases,
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
      pickedProjectHosts: picked
        ? populated
            .filter((r) => r.projects.some((p) => p.projectId === picked))
            .map((r) => r.name)
        : null,
    };
    const model = await this.deps.model();
    const { value: raw, traceId } = await this.deps.inference.run(
      "route",
      input,
      {
        model,
        ...(options.about ? { threadId: options.about } : {}),
        label: text.replace(/\s+/g, " "),
        links: options.about ? [{ kind: "thread", ref: options.about }] : [],
        signal: options.signal,
      },
    );
    const idOf = new Map(records.map((r) => [r.name, r.sectionId]));
    const titleOf = new Map(threads.map((t) => [t.id, t]));
    explain(`The model answered ${describeRaw(raw, titleOf)}.`);
    const base = {
      id: randomUUID(),
      confidence: "low" as const,
      reason: "",
      subject: null,
      traceId,
    };
    let decision: RouteDecision;
    if (destination?.kind === "none") {
      const inferred = this.inferredProject(raw);
      decision = {
        ...base,
        outcome: "new-thread",
        sectionId: null,
        workstream: null,
        title: "title" in raw ? raw.title : "",
        reason: "No workstream was chosen explicitly.",
        placement: await this.placement(
          null,
          false,
          selectedProject ?? inferred,
          explicitEnvironment,
          true,
        ),
      };
    } else if (raw.outcome === "continue") {
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
      explain(
        `"${raw.name}" is already a workstream, so this starts a thread there instead of creating a duplicate.`,
      );
      decision = {
        ...base,
        outcome: "new-thread",
        sectionId: record.sectionId,
        workstream: record.name,
        title: raw.title,
        confidence: raw.confidence,
        reason: raw.reason,
        subject: raw.subject,
        placement: options.suggest
          ? await this.suggestedPlacement(record.sectionId, raw.code, explain)
          : await this.placement(
              record.sectionId,
              raw.code,
              picked,
              explicitEnvironment,
            ),
      };
    } else if (raw.outcome === "new-thread") {
      const sectionId = idOf.get(raw.workstream)!;
      decision = {
        ...base,
        ...raw,
        sectionId,
        placement: options.suggest
          ? await this.suggestedPlacement(sectionId, raw.code, explain)
          : await this.placement(
              sectionId,
              raw.code,
              picked,
              explicitEnvironment,
            ),
      };
    } else if (raw.outcome === "new-workstream") {
      const like = raw.projectLike ? idOf.get(raw.projectLike) : undefined;
      explain(
        options.suggest && raw.code && !like
          ? "It's code work related to no listed workstream, so the project and environment stay as they are."
          : like
            ? `Placed like "${raw.projectLike}", whose project it shares.`
            : "It isn't code work, so it goes to the home project or the personal workspace.",
      );
      decision = {
        ...base,
        outcome: "new-workstream",
        name: intent?.workstreamName?.trim() || raw.name,
        description: raw.description,
        title: raw.title,
        confidence: raw.confidence,
        reason: raw.reason,
        subject: raw.subject,
        // A suggested code effort with no related workstream has no project
        // evidence; accepting it leaves the user's project as it is.
        placement:
          options.suggest && raw.code && !like
            ? null
            : await this.placement(
                like ?? null,
                raw.code,
                picked,
                explicitEnvironment,
                intent?.action === "new-workstream",
              ),
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
    if (options.suggest && decision.outcome === "unsure")
      decision = await this.likeliest(decision, explain);
    if (
      options.suggest &&
      decision.outcome === "continue" &&
      decision.confidence !== "high"
    )
      decision = await this.suggestNewThread(decision, explain);
    decision = this.constrain(decision, intent);
    this.deps.inference.annotate(traceId, {
      decision: { ...decision, traceId: undefined },
    });
    return remember(decision);
  }

  /** Validates the preview snapshot and consumes it synchronously, before SDK work. */
  claim(options: {
    id: string;
    prompt: string;
    intent?: RouteIntent | null;
  }): RouteClaim {
    const decision = this.recall(options);
    if (!decision) throw new UserError("That preview expired; route it again.");
    const entry = this.decisions.get(options.id)!;
    if (JSON.stringify(entry.intent) !== JSON.stringify(options.intent ?? null))
      throw new UserError("That preview changed; route it again.");
    entry.used = true;
    const claim = { decision, prompt: entry.prompt, intent: entry.intent };
    this.claims.add(claim);
    return claim;
  }

  /** Resolves only a reviewed unsure candidate; it never classifies the prompt again. */
  async resolveCandidate(
    claim: RouteClaim,
    sectionId: string,
  ): Promise<RouteDecision> {
    if (
      !this.claims.has(claim) ||
      claim.decision.outcome !== "unsure" ||
      !claim.decision.candidates.some(
        (c) => c.kind === "workstream" && c.sectionId === sectionId,
      )
    )
      throw new UserError("That choice isn't one of the candidates.");
    const record = this.deps.map.get(sectionId);
    if (!record) throw new UserError("That workstream no longer exists.");
    return {
      ...claim.decision,
      outcome: "new-thread",
      sectionId,
      workstream: record.name,
      title: "",
      placement: await this.placement(
        sectionId,
        true,
        claim.intent?.placement?.projectId,
        claim.intent?.placement?.environment,
      ),
    };
  }

  /**
   * A suggestion's placement in `sectionId`. Code work needs the
   * workstream's primary project as evidence; without one the suggestion
   * names only the workstream and leaves the user's project as it is.
   */
  private async suggestedPlacement(
    sectionId: string,
    code: boolean,
    explain: (note: string) => void,
  ): Promise<Placement | null> {
    const record = this.deps.map.get(sectionId);
    const primary = record?.projects.find((p) => p.role === "primary");
    if (code && !primary) {
      explain(
        `"${record?.name ?? sectionId}" has no primary project yet, so the project and environment stay as they are.`,
      );
      return null;
    }
    const placement = await this.placement(sectionId, code, null);
    explain(
      code
        ? `Code work goes to "${record?.name}"'s primary project (where most of its threads run), in its ${placement?.label ?? "default environment"}.`
        : `It isn't code work, so it goes to the home project or the personal workspace (${placement?.label ?? "none"}).`,
    );
    return placement;
  }

  /**
   * An unsure decision's first candidate, which the model lists as the
   * likeliest, as a decision of its own. With no candidates it stays unsure.
   */
  private async likeliest(
    decision: Extract<RouteDecision, { outcome: "unsure" }>,
    explain: (note: string) => void,
  ): Promise<RouteDecision> {
    const top = decision.candidates[0];
    if (!top) {
      explain(
        "The model was unsure and named no candidates, so there's no suggestion.",
      );
      return decision;
    }
    explain(
      `The model was unsure among ${decision.candidates.length} candidate${decision.candidates.length === 1 ? "" : "s"}; suggesting the first, which it lists as the likeliest.`,
    );
    const base = {
      id: decision.id,
      confidence: "low" as const,
      reason: decision.reason,
      subject: decision.subject,
      traceId: decision.traceId,
    };
    if (top.kind === "thread") {
      const target = this.deps.service
        .threads()
        .find((t) => t.id === top.threadId);
      const sectionId = target?.sectionId ?? null;
      return {
        ...base,
        outcome: "continue",
        threadId: top.threadId,
        threadTitle: top.title,
        sectionId,
        workstream: sectionId
          ? (this.deps.map.get(sectionId)?.name ?? null)
          : null,
      };
    }
    return {
      ...base,
      outcome: "new-thread",
      sectionId: top.sectionId,
      workstream: top.name,
      title: "",
      placement: await this.suggestedPlacement(top.sectionId, true, explain),
    };
  }

  private async suggestNewThread(
    continued: Extract<RouteDecision, { outcome: "continue" }>,
    explain: (note: string) => void,
  ): Promise<NewThreadDecision> {
    explain(
      "The continuation is uncertain, so the suggestion starts a new thread in the same workstream.",
    );
    return {
      id: continued.id,
      outcome: "new-thread",
      sectionId: continued.sectionId,
      workstream: continued.workstream,
      title: "",
      placement: continued.sectionId
        ? await this.suggestedPlacement(continued.sectionId, true, explain)
        : null,
      confidence: continued.confidence,
      reason: "Start a new thread because the task continuation is uncertain.",
      subject: continued.subject,
      traceId: continued.traceId,
    };
  }

  /**
   * The new thread to start instead of continuing `continued`: in the
   * target's workstream, or unfiled in the target's project when the target
   * has no workstream.
   */
  private async newThreadInstead(
    continued: Extract<RouteDecision, { outcome: "continue" }>,
    picked: string | null,
    environment: Environment | undefined,
  ): Promise<NewThreadDecision> {
    const target = this.deps.service
      .threads()
      .find((t) => t.id === continued.threadId);
    const sectionId =
      continued.sectionId && this.deps.map.get(continued.sectionId)
        ? continued.sectionId
        : null;
    return {
      id: randomUUID(),
      outcome: "new-thread",
      sectionId,
      workstream: sectionId ? continued.workstream : null,
      title: "",
      placement: await this.placement(
        sectionId,
        true,
        picked ?? (sectionId ? null : (target?.projectId ?? null)),
        environment,
      ),
      confidence: continued.confidence,
      reason: `Started instead of continuing ${continued.threadTitle}.`,
      subject: continued.subject,
      traceId: continued.traceId,
    };
  }

  /** Every exit, including mentions, offers only outcomes compatible with the chosen action. */
  private constrain(
    decision: RouteDecision,
    intent: RouteIntent | null,
  ): RouteDecision {
    const action = intent?.action;
    if (!action) return decision;
    const allowed = action === "send-message" ? "continue" : action;
    if (decision.outcome === allowed) return decision;
    const candidates =
      decision.outcome === "unsure"
        ? decision.candidates
        : decision.outcome === "continue" &&
            decision.sectionId &&
            decision.workstream
          ? [
              {
                kind: "workstream" as const,
                sectionId: decision.sectionId,
                name: decision.workstream,
              },
            ]
          : decision.outcome === "new-thread" &&
              decision.sectionId &&
              decision.workstream
            ? [
                {
                  kind: "workstream" as const,
                  sectionId: decision.sectionId,
                  name: decision.workstream,
                },
              ]
            : [];
    return {
      id: decision.id,
      outcome: "unsure",
      confidence: "low",
      subject: decision.subject,
      reason: "Choose a destination compatible with the selected action.",
      traceId: decision.traceId,
      candidates: candidates.filter((c) =>
        action === "send-message"
          ? c.kind === "thread"
          : action === "new-thread"
            ? c.kind === "workstream"
            : false,
      ),
    };
  }

  /** Classification is placement evidence only for explicitly unassigned work. */
  private inferredProject(raw: RawRoute): string | null {
    const records = this.deps.map.list();
    const threads = this.deps.service.threads();
    const candidates =
      raw.outcome === "unsure"
        ? raw.candidates
        : raw.outcome === "continue"
          ? [{ threadId: raw.threadId }]
          : raw.outcome === "new-thread"
            ? [{ workstream: raw.workstream }]
            : raw.projectLike
              ? [{ workstream: raw.projectLike }]
              : [];
    if (!candidates.length) return null;
    const evidence = candidates.map((c) => {
      if ("threadId" in c) {
        const thread = threads.find((t) => t.id === c.threadId);
        return thread?.projectId ? [thread.projectId] : [];
      }
      return (
        records
          .find((r) => r.name === c.workstream)
          ?.projects.map((p) => p.projectId) ?? []
      );
    });
    if (evidence.some((ids) => ids.length !== 1)) return null;
    const projects = new Set(evidence.flat());
    return projects.size === 1 ? [...projects][0]! : null;
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
      intent?: RouteIntent | null;
      claim?: RouteClaim;
    } = {},
  ): Promise<{ threadId: string | null; sectionId: string | null }> {
    const claim =
      options.claim ??
      this.claim({ id: decision.id, prompt, intent: options.intent });
    if (!this.claims.delete(claim) || claim.decision.id !== decision.id)
      throw new UserError("That preview expired; route it again.");
    const text = options.message ?? prompt;
    if (decision.outcome === "unsure")
      return { threadId: null, sectionId: null };
    if (decision.outcome === "continue")
      return {
        ...(await this.send(decision.threadId, source, {
          input: options.execution?.input ?? [
            { type: "text", text, mentions: [] },
          ],
          rationale: `Sent to ${decision.threadTitle}: ${decision.reason}`,
          traceId: decision.traceId,
        })),
        sectionId: null,
      };
    const placement = decision.placement;
    if (!placement)
      throw new UserError("Choose a project before creating this work.");
    const executionEnvironment =
      options.execution?.projectId === placement.projectId
        ? options.execution.environment
        : undefined;
    // An explicit intent is bound to the preview; execution cannot replace it.
    if (
      claim.intent?.placement?.environment &&
      executionEnvironment &&
      JSON.stringify(executionEnvironment) !==
        JSON.stringify(placement.environment)
    )
      throw new UserError("That preview changed; route it again.");
    const environment = executionEnvironment ?? placement.environment;
    await this.validateEnvironment(placement.projectId, environment);
    if (
      decision.outcome === "new-thread" &&
      decision.sectionId &&
      !this.deps.map.get(decision.sectionId)
    )
      throw new UserError("That workstream no longer exists.");
    let sectionId: string | null;
    let newlyCreatedSectionId: string | null = null;
    if (decision.outcome === "new-workstream") {
      const created = await this.deps.service.createWorkstream(
        decision.name,
        source,
      );
      sectionId = created.sectionId;
      newlyCreatedSectionId = created.sectionId;
      if (decision.description)
        this.deps.map.describe(sectionId, decision.description);
    } else sectionId = decision.sectionId;
    const actualSectionId = sectionId;
    // The composer's own input keeps attachments and mentions; otherwise send
    // the text.
    const body =
      options.execution &&
      "input" in options.execution &&
      options.execution.input
        ? { input: options.execution.input }
        : { prompt: text };
    let thread: { id: string; title?: string | null };
    try {
      thread = await this.spawnFiled(
        {
          ...options.execution,
          ...body,
          projectId: placement.projectId,
          environment,
        } as SpawnArgs,
        actualSectionId,
        source,
        options.spawnedFrom,
      );
      this.deps.service.seeThread(
        thread.id,
        actualSectionId,
        options.spawnedFrom ?? null,
        thread.title ?? undefined,
      );
    } catch (error) {
      if (newlyCreatedSectionId) {
        try {
          this.deps.corpus?.unbindGroup(newlyCreatedSectionId);
          await this.deps.sdk().threadSections.delete({ id: newlyCreatedSectionId });
        } catch {
          // ignore rollback errors
        }
      }
      throw error;
    }

    let assignedEntityId: string | null = null;
    if (decision.proposal) {
      const entity = this.deps.corpus?.rememberProposal(decision.proposal);
      if (entity) {
        assignedEntityId = entity.id;
        this.deps.corpus?.assign(thread.id, entity.id, { provenance: "automatic" });
      }
    } else if (decision.subjectId) {
      assignedEntityId = decision.subjectId;
      this.deps.corpus?.assign(thread.id, decision.subjectId, { provenance: "automatic" });
    }

    if (newlyCreatedSectionId && assignedEntityId) {
      this.deps.corpus?.bindGroup(newlyCreatedSectionId, assignedEntityId);
    }

    const logged = this.deps.service.recordCreated(
      thread.id,
      actualSectionId,
      source,
      {
        title: decision.title || thread.title || "New thread",
        rationale:
          decision.outcome === "new-workstream"
            ? `Started in new workstream ${decision.name}: ${decision.reason}`
            : decision.workstream
              ? `Started in ${decision.workstream}: ${decision.reason}`
              : `Started without a workstream: ${decision.reason}`,
      },
    );
    this.deps.inference.link(
      decision.traceId,
      { kind: "thread", ref: thread.id },
      { kind: "entry", ref: logged.id },
      ...(decision.outcome === "new-workstream" && sectionId
        ? [{ kind: "section" as const, ref: sectionId }]
        : []),
    );
    return { threadId: thread.id, sectionId: actualSectionId };
  }

  /**
   * Starts New work's thread exactly as the composer resolved it, filed in
   * `sectionId` or deliberately left without a workstream.
   */
  async start(
    optionsOrSectionId:
      | string
      | null
      | {
          sectionId?: string | null;
          newWorkstream?: { name: string; description?: string } | null;
          identity?: {
            entityId?: string | null;
            proposal?: DraftSubjectProposal | null;
            provenance?: "manual" | "automatic";
          } | null;
          execution: SpawnArgs & { projectId: string; environment: Environment };
        },
    legacyExecution?: SpawnArgs & { projectId: string; environment: Environment },
    legacySubjectId?: string,
  ): Promise<{ threadId: string; sectionId: string | null }> {
    let sectionId: string | null;
    let newWorkstream: { name: string; description?: string } | null;
    let identity: {
      entityId?: string | null;
      proposal?: DraftSubjectProposal | null;
      provenance?: "manual" | "automatic";
    } | null;
    let execution: SpawnArgs & { projectId: string; environment: Environment };

    if (
      typeof optionsOrSectionId === "object" &&
      optionsOrSectionId !== null &&
      "execution" in optionsOrSectionId
    ) {
      sectionId = optionsOrSectionId.sectionId ?? null;
      newWorkstream = optionsOrSectionId.newWorkstream ?? null;
      identity = optionsOrSectionId.identity ?? null;
      execution = optionsOrSectionId.execution;
    } else {
      sectionId = optionsOrSectionId;
      newWorkstream = null;
      identity = legacySubjectId
        ? { entityId: legacySubjectId, provenance: "manual" }
        : null;
      execution = legacyExecution!;
    }

    let effectiveSectionId = sectionId;
    let createdSectionId: string | null = null;
    if (newWorkstream) {
      const created = await this.deps.service.createWorkstream(
        newWorkstream.name,
        "user",
      );
      createdSectionId = created.sectionId;
      effectiveSectionId = created.sectionId;
      if (newWorkstream.description) {
        this.deps.map.describe(createdSectionId, newWorkstream.description);
      }
    }

    const record = effectiveSectionId ? this.deps.map.get(effectiveSectionId) : null;
    if (effectiveSectionId && !record)
      throw new UserError("That workstream no longer exists.");

    if (identity?.entityId && !this.deps.corpus?.getById(identity.entityId))
      throw new UserError("Unknown subject identity.");

    // Only fields BB's new-thread request defines reach spawn.
    const fields = Object.fromEntries(
      START_FIELDS.filter((key) => execution[key] !== undefined).map((key) => [
        key,
        execution[key],
      ]),
    ) as unknown as SpawnArgs;

    let thread: { id: string; title?: string | null };
    try {
      thread = await this.spawnFiled(fields, effectiveSectionId, "user");
      this.deps.service.seeThread(
        thread.id,
        effectiveSectionId,
        null,
        thread.title ?? undefined,
      );
    } catch (error) {
      if (createdSectionId) {
        try {
          this.deps.corpus?.unbindGroup(createdSectionId);
          await this.deps.sdk().threadSections.delete({ id: createdSectionId });
        } catch {
          // ignore cleanup errors on rollback
        }
      }
      throw error;
    }

    let assignedEntityId: string | null = null;
    if (identity?.proposal) {
      const entity = this.deps.corpus!.rememberProposal(identity.proposal);
      assignedEntityId = entity.id;
      this.deps.corpus!.assign(thread.id, entity.id, {
        provenance: identity.provenance ?? "automatic",
      });
    } else if (identity?.entityId) {
      assignedEntityId = identity.entityId;
      this.deps.corpus!.assign(thread.id, identity.entityId, {
        provenance: identity.provenance ?? "manual",
      });
    }

    if (createdSectionId && assignedEntityId) {
      this.deps.corpus?.bindGroup(createdSectionId, assignedEntityId);
    }

    this.deps.service.recordCreated(thread.id, effectiveSectionId, "user", {
      title: thread.title || "New thread",
      rationale: record
        ? `Started in ${record.name} from New work`
        : "Started without a workstream from New work",
    });
    return { threadId: thread.id, sectionId: effectiveSectionId };
  }

  /**
   * Sends `input` to an existing thread, queued behind any running turn, and
   * journals it. `traceId` links the routing call that suggested the thread.
   */
  async send(
    threadId: string,
    source: Source,
    options: {
      input: SendArgs["input"];
      rationale?: string;
      traceId?: string | null;
    },
  ): Promise<{ threadId: string }> {
    const sdk = this.deps.sdk();
    const target = await sdk.threads.get({ threadId });
    if (target.archivedAt !== null)
      throw new UserError("That thread is archived.");
    await sdk.threads.send({
      threadId,
      input: options.input,
      mode: "queue-if-active",
    });
    const title = target.title ?? target.titleFallback ?? threadId;
    const logged = this.deps.journal.add({
      action: "route",
      source,
      rationale: options.rationale ?? `Sent to ${title} from New work`,
      threads: [{ id: threadId, name: title }],
      workstreams: [],
      undo: null,
    });
    this.deps.inference.link(
      options.traceId ?? null,
      { kind: "thread", ref: threadId },
      { kind: "entry", ref: logged.id },
    );
    return { threadId };
  }

  /**
   * Spawns a top-level task thread in `sectionId` with the metadata that
   * records who filed it; a null section marks it deliberately unassigned so
   * composer filing leaves it alone.
   */
  private spawnFiled(
    args: SpawnArgs,
    sectionId: string | null,
    source: Source,
    spawnedFrom?: string | null,
  ) {
    const at = this.now();
    return withRetry(() =>
      this.deps.sdk().threads.spawn({
        ...args,
        sectionId,
        pluginMetadata: {
          kind: "task",
          ...(sectionId
            ? { workstreamAtCreation: sectionId }
            : { unassignedByRouter: true }),
          filedBy: source,
          filedAt: at,
          filedSectionId: sectionId,
          ...(spawnedFrom ? { spawnedFrom } : {}),
        },
      } as SpawnArgs),
    );
  }

  /**
   * Files a thread the native composer just created, per the preview the user
   * saw. Handles a composer thread only once.
   */
  async fileComposed(
    threadId: string,
    decision: RouteDecision,
    identityOverride?: {
      entityId?: string | null;
      proposal?: DraftSubjectProposal | null;
      provenance?: "manual" | "automatic";
    } | null,
  ): Promise<void> {
    const entry = this.decisions.get(decision.id);
    if (!entry || entry.used) return;
    entry.used = true;

    let sectionId: string | null = null;
    let newlyCreatedSectionId: string | null = null;
    if (decision.outcome === "new-thread") {
      sectionId = decision.sectionId;
    } else if (decision.outcome === "new-workstream") {
      const created = await this.deps.service.createWorkstream(
        decision.name,
        "router",
      );
      sectionId = created.sectionId;
      newlyCreatedSectionId = created.sectionId;
      if (decision.description)
        this.deps.map.describe(sectionId, decision.description);
    } else if (decision.outcome === "continue") {
      // The user started a new thread instead: keep it with that thread's work.
      const target = this.deps.service
        .threads()
        .find((t) => t.id === decision.threadId);
      sectionId = target?.sectionId ?? null;
    }

    this.deps.service.seeThread(threadId, sectionId, null);

    let assignedEntityId: string | null = null;
    const identity = identityOverride ?? {
      entityId: decision.subjectId ?? null,
      proposal: decision.proposal ?? null,
      provenance: "automatic" as const,
    };

    if (identity.proposal) {
      const entity = this.deps.corpus?.rememberProposal(identity.proposal);
      if (entity) {
        assignedEntityId = entity.id;
        this.deps.corpus?.assign(threadId, entity.id, {
          provenance: identity.provenance ?? "automatic",
        });
      }
    } else if (identity.entityId) {
      assignedEntityId = identity.entityId;
      this.deps.corpus?.assign(threadId, identity.entityId, {
        provenance: identity.provenance ?? "manual",
      });
    }

    if (sectionId && assignedEntityId) {
      this.deps.corpus?.bindGroup(
        sectionId,
        this.deps.corpus.groups().get(sectionId) ?? assignedEntityId,
      );
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
   * explicit). Automatic placement uses the project's default source machine;
   * an explicit environment selection is validated and kept as-is.
   */
  private async placement(
    sectionId: string | null,
    code: boolean,
    picked: string | null | undefined,
    environment?: Environment,
    requireProject = false,
  ): Promise<Placement | null> {
    const projects = sectionId
      ? (this.deps.map.get(sectionId)?.projects ?? [])
      : [];
    const chosen = code
      ? projects.find((p) => p.role === "primary")
      : undefined;
    let projectId = picked ?? chosen?.projectId ?? null;
    let label: Placement["label"] =
      chosen?.environment === "worktree" ? "worktree" : "checkout";
    if (!projectId) {
      if (requireProject) return null;
      projectId =
        (await this.deps.homeProjectId()).trim() ||
        (await this.personalProjectId());
    }
    const personal = await this.personalProjectId();
    if (projectId === personal) label = "personal workspace";
    else if (picked)
      label =
        projects.find((p) => p.projectId === picked)?.environment === "worktree"
          ? "worktree"
          : "checkout";
    if (environment) {
      await this.validateEnvironment(projectId, environment);
      return {
        projectId,
        environment,
        label:
          environment.type === "reuse"
            ? "existing environment"
            : environment.type === "host"
              ? environment.workspace.type === "managed-worktree"
                ? "worktree"
                : environment.workspace.type === "personal"
                  ? "personal workspace"
                  : "checkout"
              : environment.type === "provider"
                ? "provider environment"
                : "project default",
      };
    }
    return this.on(projectId, label);
  }

  private async project(projectId: string) {
    const projects = await this.deps
      .sdk()
      .projects.list({ includePersonal: true });
    const project = projects.find((p) => p.id === projectId);
    if (!project)
      throw new UserError(
        "That project no longer exists. Choose another project.",
      );
    return project;
  }

  private async validateEnvironment(
    projectId: string,
    environment: Environment,
  ): Promise<void> {
    await this.project(projectId);
    const sdk = this.deps.sdk();
    if (environment.type === "reuse") {
      const target = await sdk.environments.get({
        environmentId: environment.environmentId,
      });
      if (target.projectId !== projectId)
        throw new UserError("That environment belongs to another project.");
      if (
        target.status !== "ready" ||
        target.hostLifecycle !== "active" ||
        (target.lifecycle.phase !== "active" &&
          target.lifecycle.phase !== "retiring")
      )
        throw new UserError(
          "That environment is unavailable. Choose another environment.",
        );
      const hosts = await sdk.hosts.list();
      if (
        !hosts.some((h) => h.id === target.hostId && h.status === "connected")
      )
        throw new UserError("That environment's machine is unavailable.");
    } else if (environment.type === "host" && environment.hostId) {
      const hosts = await sdk.hosts.list();
      if (
        !hosts.some(
          (h) => h.id === environment.hostId && h.status === "connected",
        )
      )
        throw new UserError("That machine is unavailable.");
    }
  }

  private async on(projectId: string, label: string): Promise<Placement> {
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
      },
    };
  }

  private async hostFor(projectId: string): Promise<string | null> {
    const sdk = this.deps.sdk();
    const project = await this.project(projectId);
    const source =
      project.sources.find((s) => s.isDefault) ?? project.sources[0];
    if (source) return source.hostId;
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

  private remember<T extends RouteDecision>(
    prompt: string,
    decision: T,
    intent: RouteIntent | null = null,
  ): T {
    this.prune();
    this.decisions.set(decision.id, {
      decision,
      prompt,
      intent: intent ? structuredClone(intent) : null,
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

/** One line of what the model answered, for Debug mode's notes. */
function describeRaw(
  raw: RawRoute,
  titleOf: ReadonlyMap<string, { title: string }>,
): string {
  const how = "confidence" in raw ? ` (${raw.confidence} confidence)` : "";
  switch (raw.outcome) {
    case "continue":
      return `continue "${titleOf.get(raw.threadId)?.title ?? raw.threadId}"${how}`;
    case "new-thread":
      return `start a ${raw.code ? "code" : "non-code"} thread in "${raw.workstream}"${how}`;
    case "new-workstream":
      return `start a ${raw.code ? "code" : "non-code"} effort in a new workstream "${raw.name}"${how}`;
    case "unsure":
      return `unsure, with ${raw.candidates.length} candidate${raw.candidates.length === 1 ? "" : "s"}`;
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
