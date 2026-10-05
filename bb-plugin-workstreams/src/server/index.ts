/**
 * Workstreams server entry. Organizes BB threads into workstreams (native
 * sections), records every change in the journal, and reconciles with changes
 * made elsewhere. See SPEC.md.
 */
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { actOn, registerCli } from "./cli.ts";
import { GOAL_MAX, isCurrent } from "../domain/analysis.ts";
import { registerAgentInstructions } from "./agents.ts";
import { Analyzer } from "./analyzer.ts";
import { RecapArchive } from "./archive.ts";
import { Coordinator } from "./coordinator.ts";
import { sectionMembers } from "./cleanup.ts";
import { WorkstreamMap } from "./map.ts";
import { Router, type RouteDecision } from "./router.ts";
import { CorpusStore, classificationEvidence } from "./corpus.ts";
import { ComposedDrafts, type ComposedIdentity } from "./composed-drafts.ts";
import { corpusLabel } from "../domain/corpus-label.ts";
import { ancestors, activeHome } from "../domain/regroup.ts";
import type { CanonicalAssignment } from "../domain/corpus.ts";
import { rpcContract } from "./contract.ts";
import { hostContract } from "./inference/contract.ts";
import { openDatabase } from "./db.ts";
import { Journal } from "./journal.ts";
import { Inference } from "./model.ts";
import { adoptStoredGoals } from "./adopt.ts";
import { OpeningTitles } from "./opening.ts";
import { loadOrder, saveOrder } from "./order.ts";
import { loadSpinner, saveSpinner } from "./spinner.ts";
import { UserError, WorkstreamService } from "./service.ts";
import type { RetitleBasis } from "../domain/titles.ts";
import { TraceStore } from "./trace.ts";
import { AgentRecaps } from "./recap.ts";
import { registerQuestionTool } from "./questions/tool.ts";
import { QuestionStore } from "./questions/store.ts";
import {
  loadRecapPrefs,
  recapToolSince,
  saveRecapPrefs,
} from "./recapPrefs.ts";
import { ThreadSnoozes, loadSnoozePrefs, saveSnoozePrefs } from "./snooze.ts";
import { hasPrefs, loadPrefs, savePrefs, seedPrefs } from "./prefs.ts";
import {
  DEFAULT_MODELS,
  gatewayModel,
  type ModelChoice,
} from "../domain/prefs.ts";
import { runWorker as completeWithWorker } from "./inference/worker.ts";

export { rpcContract } from "./contract.ts";

const RECONCILE_EVERY_MS = 60_000;
const RECONCILE_DEBOUNCE_MS = 1_500;

/** The furthest out a snooze can wake. */
const MAX_SNOOZE_MS = 366 * 24 * 60 * 60 * 1000;

export default async function plugin(bb: BbPluginApi) {
  const db = openDatabase(bb);
  if (!hasPrefs(db)) {
    try {
      const legacy = await bb.sdk.plugins.getSettings({
        pluginId: "workstreams",
      });
      seedPrefs(db, legacy.values);
    } catch (error) {
      bb.log.warn(
        `Could not migrate Workstreams settings; using defaults: ${String(error)}`,
      );
      seedPrefs(db, null);
    }
  }
  const journal = new Journal(db);
  const notify = () => bb.realtime.publish("changed", {});
  const service = new WorkstreamService(() => bb.sdk, db, journal, notify);
  const snoozes = new ThreadSnoozes(db);
  /**
   * Drops snoozes that ended, against the reconciler's fresh thread list.
   * A thread whose wake time came returns marked unread.
   */
  const sweepSnoozes = async () => {
    const { ended, timed } = snoozes.sweep(service.threads(), Date.now());
    if (!ended.length) return;
    notify();
    for (const threadId of timed)
      await bb.sdk.threads
        .markUnread({ threadId })
        .catch((error: unknown) =>
          bb.log.warn(`Marking ${threadId} unread failed: ${String(error)}`),
        );
  };

  // Set once the organizer exists; earlier triggers have nothing to start.
  let organizer: Coordinator | null = null;
  const triggerCoordinator = (debounceMs = 50) => {
    organizer?.trigger(debounceMs);
  };

  const currentPrefs = () => loadPrefs(db);
  const hostRpc = bb.hosts.experimental_client({ contract: hostContract });
  const analysisHost = async (): Promise<string> => {
    const connected = (await bb.sdk.hosts.list()).filter(
      (host) => host.status === "connected",
    );
    const { hostId } = currentPrefs().advanced;
    const host = hostId.trim()
      ? connected.find((h) => h.id === hostId.trim())
      : connected.length === 1
        ? connected[0]
        : undefined;
    if (!host)
      throw new Error(
        "No analysis machine: set Workstreams' Analysis machine ID to a connected machine with Pi and AI Gateway.",
      );
    return host.id;
  };
  const completeWorker = async (
    prompt: string,
    choice: ModelChoice,
    signal?: AbortSignal,
    context?: { threadId?: string },
  ) => {
    let projectId: string | undefined;
    let environmentId: string | undefined;
    if (context?.threadId) {
      const subject = await bb.sdk.threads.get({
        threadId: context.threadId,
        signal,
      });
      projectId = subject.projectId;
      environmentId = subject.environmentId ?? undefined;
    }
    if (!projectId) {
      const homeProjectId = currentPrefs().newWork.homeProjectId;
      const projects = await bb.sdk.projects.list();
      projectId =
        (homeProjectId &&
        projects.some((project) => project.id === homeProjectId)
          ? homeProjectId
          : undefined) ?? projects[0]?.id;
    }
    if (!projectId)
      throw new Error("No project is available for a Workstreams worker.");
    return completeWithWorker(
      bb.sdk,
      prompt,
      choice,
      projectId,
      environmentId,
      signal,
    );
  };
  const traces = new TraceStore(db);
  const inference = new Inference({
    complete: async (prompt, choice, signal, maxTokens, context) => {
      const direct = gatewayModel(choice);
      if (direct !== null)
        return hostRpc.call(
          "complete",
          {
            prompt,
            model: direct,
            ...(maxTokens ? { maxTokens } : {}),
            ...(choice.kind === "provider"
              ? {
                  reasoningLevel: choice.reasoningLevel,
                  ...(choice.serviceTier
                    ? { serviceTier: choice.serviceTier }
                    : {}),
                }
              : {}),
          },
          { hostId: await analysisHost(), timeoutMs: 95_000, signal },
        );
      return completeWorker(prompt, choice, signal, context);
    },
    traces,
    debug: async () => currentPrefs().advanced.debug,
    log: (message) => bb.log.warn(message),
  });
  // Retention also applies while Debug mode is off and nothing is recorded.
  traces.prune({ force: true });
  /**
   * Gives a thread its goal as its title, when the retitle policy and the
   * `autoTitle` preference allow it, and records the outcome on the call's
   * trace.
   */
  const applyGoal = async (
    threadId: string,
    goal: string,
    revision: number,
    traceId: string | null | undefined,
    basis: RetitleBasis,
  ): Promise<void> => {
    try {
      if (!currentPrefs().threads.autoTitle) {
        inference.annotate(traceId, {
          title: "not applied: the autoTitle setting is off",
        });
        return;
      }
      const { entry, skipped } = await service.retitle(
        threadId,
        goal,
        revision,
        basis,
      );
      if (entry) inference.link(traceId, { kind: "entry", ref: entry.id });
      inference.annotate(traceId, {
        title: entry ? "applied" : `not applied: ${skipped}`,
      });
    } catch (error) {
      bb.log.warn(`Retitling ${threadId} failed: ${String(error)}`);
    }
  };
  const analyzer = new Analyzer({
    sdk: () => bb.sdk,
    db,
    model: async () => currentPrefs().threads.analysisModel,
    inference,
    onChange: notify,
    onResult: (threadId, result) => {
      // A finished analysis can change whether the thread counts as done.
      triggerCoordinator();
      // A goal carried over from before goals were capped can be too long for
      // a title.
      if (result.goal && result.goal.length <= GOAL_MAX)
        void applyGoal(
          threadId,
          result.goal,
          result.revision,
          result.traceId,
          "analysis",
        );
    },
    log: (message) => bb.log.warn(message),
    info: (message) => bb.log.info(message),
  });
  const opening = new OpeningTitles({
    sdk: () => bb.sdk,
    db,
    inference,
    model: async () => currentPrefs().threads.analysisModel,
    enabled: () => currentPrefs().threads.autoTitle,
    analyzed: (threadId) => analyzer.get(threadId) !== undefined,
    apply: (threadId, goal, revision, traceId) =>
      applyGoal(threadId, goal, revision, traceId, "opening"),
    log: (message) => bb.log.warn(message),
  });
  bb.onDispose(() => opening.dispose());
  bb.onDispose(() => analyzer.dispose());
  const recaps = new AgentRecaps({
    bb,
    db,
    prefs: () => loadRecapPrefs(db),
    since: () => recapToolSince(db),
    onChange: () => {
      notify();
      // A reported or cleared recap can change whether the thread is done.
      triggerCoordinator(200);
    },
  });
  recapToolSince(db);
  recaps.register();
  bb.onDispose(() => recaps.dispose());
  const archives = new RecapArchive({
    sdk: () => bb.sdk,
    recaps,
    analyzer,
    onChange: notify,
  });
  const questions = new QuestionStore(db, bb);
  registerQuestionTool(bb, questions);
  registerAgentInstructions(bb, recaps);
  const map = new WorkstreamMap(db);
  const corpus = new CorpusStore(db);
  const coordinator = new Coordinator({
    db,
    service,
    corpus,
    analyzer,
    recaps: () => recaps.all(),
    inference,
    model: async () => currentPrefs().organize.model,
    classificationModel: async () => currentPrefs().organize.model,
    requests: (threadId) => analyzer.ownershipRequests(threadId),
    policy: () => ({
      capacity: currentPrefs().organize.capacity,
      collapseAt: currentPrefs().organize.collapseAt,
    }),
    projects: async () => bb.sdk.projects.list(),
    members: (sectionId) => sectionMembers(bb.sdk, sectionId),
    journal,
    onChange: notify,
  });
  organizer = coordinator;
  bb.onDispose(() => coordinator.dispose());
  const router = new Router({
    sdk: () => bb.sdk,
    corpus,
    service,
    journal,
    map,
    analyzer,
    recaps: () => recaps.all(),
    inference,
    model: async () => currentPrefs().newWork.suggestionsModel,
    homeProjectId: async () => currentPrefs().newWork.homeProjectId,
  });
  // The Product or feature the New thread banner showed, for threads a plain
  // Enter creates without the banner's submit data.
  const drafts = new ComposedDrafts();
  const journaledStarts = new Set<string>();
  /** Files a composed thread's identity from the New thread banner. */
  const fileComposedIdentity = (
    threadId: string,
    identity: ComposedIdentity,
  ) => {
    if (identity?.proposal) {
      const entity = corpus.rememberProposal(identity.proposal);
      corpus.assign(threadId, entity.id, {
        provenance: identity.provenance ?? "automatic",
      });
    } else if (identity?.entityId) {
      // The draft may name an entity merged or deleted since; the thread
      // then stays for automatic classification rather than failing.
      if (!corpus.getById(identity.entityId)) {
        bb.log.warn(`Composed thread ${threadId} names an unknown subject.`);
        return;
      }
      corpus.assign(threadId, identity.entityId, {
        provenance: identity.provenance ?? "manual",
      });
    } else if (identity?.provenance === "manual") {
      corpus.clear(threadId);
    }
  };
  // A thread the native composer just created is filed with the identity its
  // banner showed: from the banner's submit data, or, for a plain Enter, from
  // the draft the banner last reported with the same text. The hook itself
  // always proceeds.
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    // A thread's first request is the earliest anything can name it. The
    // naming runs apart from this admission and can't fail it.
    opening.onDispatch(ctx);
    const correction = await recaps.onDispatch(ctx);
    if (correction) return correction;
    // Sending a snoozed thread a message means you're back on it.
    if (
      ctx.initiator === "user" &&
      ctx.senderThreadId === null &&
      ctx.queuedMessages.length === 0 &&
      snoozes.clear(ctx.thread.id)
    )
      notify();
    // A thread's first message has an origin; follow-ups, steers, and retries
    // don't. Queued re-attempts of a first message still count.
    const fresh =
      ctx.origin !== null &&
      ctx.attempt === "start-turn" &&
      !ctx.thread.sectionId &&
      Date.now() - ctx.thread.createdAt < 10 * 60_000;
    if (fresh) {
      const metadata = await bb.sdk.threads.getPluginMetadata({
        threadId: ctx.thread.id,
      });
      if (metadata.unassignedByRouter === true) return { action: "proceed" };
      const ours = ctx.experimental_submission?.pluginId === bb.pluginId;
      const data = ours
        ? (ctx.experimental_submission!.data as {
            identity?: ComposedIdentity;
          } | null)
        : null;
      // Started by a person in BB's New thread view, the counterpart of a
      // New work start.
      const composed =
        ctx.origin === "app" &&
        ctx.initiator === "user" &&
        ctx.senderThreadId === null &&
        !ctx.parentThreadId;
      let identity: ComposedIdentity | undefined;
      if (ours) {
        drafts.consume(ctx.input.text);
        identity = data?.identity;
      } else if (composed) {
        identity = drafts.claim(ctx.thread.id, ctx.input.text)?.identity;
      }
      // Passes re-run on drains, restarts and retries; journal a start once.
      const journal = composed && !journaledStarts.has(ctx.thread.id);
      if (journal) {
        journaledStarts.add(ctx.thread.id);
        if (journaledStarts.size > 200)
          journaledStarts.delete(journaledStarts.values().next().value!);
      }
      setTimeout(async () => {
        try {
          if (journal)
            service.recordCreated(ctx.thread.id, null, "user", {
              title: ctx.thread.title || "New thread",
              rationale: "Started from New thread",
            });
          else
            service.seeThread(ctx.thread.id, null, ctx.parentThreadId ?? null);
          if (!ctx.parentThreadId && identity !== undefined)
            fileComposedIdentity(ctx.thread.id, identity);
          triggerCoordinator(10);
        } catch (error: unknown) {
          bb.log.warn(`Filing a composed thread failed: ${String(error)}`);
        }
      }, 0);
    }
    return { action: "proceed" };
  });
  const noSuggestionDecision = (): RouteDecision => ({
    id: randomUUID(),
    outcome: "new-thread",
    sectionId: null,
    workstream: null,
    title: "",
    placement: null,
    confidence: "low",
    reason: "Suggestions are turned off.",
    subject: null,
    traceId: null,
  });
  const choose = (
    decision: RouteDecision,
    choice: { threadId: string } | { sectionId: string } | null | undefined,
  ): RouteDecision => {
    if (!choice || decision.outcome !== "unsure") return decision;
    const picked = decision.candidates.find((c) =>
      "threadId" in choice
        ? c.kind === "thread" && c.threadId === choice.threadId
        : c.kind === "workstream" && c.sectionId === choice.sectionId,
    );
    if (!picked)
      throw new UserError("That choice isn't one of the candidates.");
    return picked.kind === "thread"
      ? {
          ...decision,
          outcome: "continue",
          threadId: picked.threadId,
          threadTitle: picked.title,
          workstream: null,
          sectionId: null,
        }
      : {
          ...decision,
          outcome: "new-thread",
          sectionId: picked.sectionId,
          workstream: picked.name,
          title: "",
          placement: null,
        };
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const reconcileSoon = (delay = RECONCILE_DEBOUNCE_MS) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      service
        .reconcile()
        .then(() => {
          analyzer.catchUp(service.threads());
          opening.sweep(service.threads());
          void adoptStoredGoals({
            db,
            threads: () => service.threads(),
            analysis: (threadId) => analyzer.get(threadId),
            enabled: () => currentPrefs().threads.autoTitle,
            retitle: (threadId, goal, revision, rationale) =>
              service.retitle(threadId, goal, revision, "analysis", rationale),
            log: (message) => bb.log.warn(message),
          })
            .then((adopted) => {
              if (adopted > 0)
                bb.log.info(
                  `Titled ${adopted} threads from their stored goals`,
                );
            })
            .catch((error: unknown) =>
              bb.log.warn(`Adopting stored goals failed: ${String(error)}`),
            );
          void sweepSnoozes();
          map.refresh(service.threads(), analyzer.all());
          triggerCoordinator(50);
        })
        .catch((error: unknown) =>
          bb.log.warn(`Reconcile failed: ${String(error)}`),
        );
    }, delay);
  };
  const interval = setInterval(() => {
    reconcileSoon(0);
    traces.prune();
  }, RECONCILE_EVERY_MS);
  bb.onDispose(() => {
    clearInterval(interval);
    if (timer) clearTimeout(timer);
  });
  reconcileSoon(0);

  for (const event of [
    "thread.created",
    "thread.archived",
    "thread.unarchived",
    "thread.deleted",
  ] as const)
    bb.events.on(event, () => {
      notify();
      reconcileSoon();
      triggerCoordinator();
    });
  bb.events.on("thread.created", async ({ thread }) => {
    const metadata = await bb.sdk.threads.getPluginMetadata({
      threadId: thread.id,
    });
    const unassigned = metadata.unassignedByRouter === true;
    if (
      thread.visibility !== "hidden" &&
      thread.archivedAt === null &&
      !unassigned
    )
      service.seeThread(
        thread.id,
        thread.sectionId ?? null,
        thread.parentThreadId ?? null,
        thread.title ?? thread.titleFallback ?? undefined,
        true,
      );
  });
  bb.events.on("thread.archived", ({ thread }) => {
    recaps.onArchived(thread.id);
    if (snoozes.clear(thread.id)) notify();
  });
  bb.events.on("interaction.pending", ({ thread, interaction }) => {
    if (
      interaction.origin?.kind === "plugin" &&
      interaction.origin.pluginId === bb.pluginId &&
      interaction.origin.rendererId === "ask-user-question"
    )
      questions.attach(thread.id, interaction.id);
    return recaps.onInteractionPending(thread.id, interaction);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    snoozes.clear(thread.id);
    analyzer.forget(thread.id);
    opening.forget(thread.id);
    recaps.forget(thread.id);
    service.forget(thread.id);
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (thread.visibility === "hidden") return;
    analyzer.onIdle(thread, lastAssistantText);
    triggerCoordinator(200);
    return recaps.onIdle(thread.id);
  });
  bb.events.on("thread.active", ({ thread }) => {
    analyzer.onActive(thread.id);
    triggerCoordinator(200);
    // Covers a thread whose first request this run didn't see dispatched.
    void opening.onRunning(thread);
  });

  const userFacing = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof UserError) throw new Error(error.message);
      throw error;
    }
  };

  // One routing preview per composer draft: a newer request or a cancel
  // aborts the model call of the one before it.
  const previews = new Map<string, AbortController>();
  const cancelPreview = (draftKey: string) => {
    const running = previews.get(draftKey);
    previews.delete(draftKey);
    running?.abort(new UserError("Canceled: the draft changed."));
    return running !== undefined;
  };

  const reclassifyTask = async (input: {
    threadId: string;
    entityId?: string | null;
    evidence?: string;
  }): Promise<{ assignment: CanonicalAssignment }> => {
    await service.reconcile();
    const rootId = corpus.findRootThread(input.threadId);
    if (input.entityId !== undefined) {
      const assignment = corpus.reclassify(
        input.threadId,
        input.entityId,
        input.evidence,
      );
      notify();
      return { assignment };
    }
    const thread = await bb.sdk.threads.get({ threadId: rootId });
    const analysis = analyzer.get(rootId);
    const requests = await analyzer.ownershipRequests(rootId);
    const projects = await bb.sdk.projects.list();
    const projectName =
      (thread.projectId
        ? projects.find((p) => p.id === thread.projectId)?.name
        : null) ?? null;
    const modelChoice = currentPrefs
      ? await currentPrefs().organize.model
      : DEFAULT_MODELS.organize;
    const { value } = await inference.run(
      "classify",
      {
        prompt: `${thread.title ?? thread.titleFallback ?? ""}\n${analysis?.recap ?? ""}`,
        entities: corpus.list(),
        project: projectName,
        requests,
      },
      {
        model: modelChoice,
        threadId: rootId,
        label: thread.title ?? rootId,
      },
    );
    const target = value.subjectId
      ? corpus.getById(value.subjectId)
      : value.proposed
        ? corpus.rememberProposal(value.proposed)
        : null;
    const computedEvidence = classificationEvidence({
      requests,
      title: thread.title ?? thread.titleFallback ?? "",
      project: projectName,
    });
    const assignment = corpus.reclassify(
      input.threadId,
      target ? target.id : null,
      computedEvidence,
    );
    notify();
    return { assignment };
  };

  bb.rpc.register(rpcContract, {
    route: ({
      prompt,
      pickedProjectId,
      workstreamId,
      selectedWorkstreamId,
      intent,
      offerNewThread,
      suggest,
      nativeComposer,
      fromDecisionId,
      draftKey,
    }) =>
      userFacing(async () => {
        const options = {
          pickedProjectId,
          workstreamId,
          selectedWorkstreamId,
          intent,
          offerNewThread,
          suggest,
          fromDecisionId,
        };
        const routed = async (signal?: AbortSignal) => {
          const prefs = currentPrefs();
          if (suggest && !prefs.newWork.suggestions)
            return noSuggestionDecision();
          const debug = suggest && prefs.advanced.debug;
          const notes: string[] = [];
          const started = Date.now();
          const decision = await router.route(prompt, {
            ...options,
            signal,
            ...(debug ? { explain: (note: string) => notes.push(note) } : {}),
          });
          // A suggestion is accepted through its own RPCs. Remembering it
          // would let BB's composer file an unrelated thread with this text.
          if (suggest && !nativeComposer) {
            router.forget(decision.id);
            if (decision.outcome === "continue" && decision.alternative)
              router.forget(decision.alternative.id);
          }
          if (suggest && nativeComposer && decision.outcome === "continue")
            router.forget(decision.id);
          return debug
            ? {
                ...decision,
                explanation: { notes, durationMs: Date.now() - started },
              }
            : decision;
        };
        if (!draftKey) return routed();
        cancelPreview(draftKey);
        const controller = new AbortController();
        previews.set(draftKey, controller);
        try {
          return await routed(controller.signal);
        } finally {
          if (previews.get(draftKey) === controller) previews.delete(draftKey);
        }
      }),
    routeCancel: async ({ draftKey }) => ({
      canceled: cancelPreview(draftKey),
    }),
    routeExecute: ({ decisionId, prompt, choice, execution, intent }) =>
      userFacing(async () => {
        const claim = router.claim({ id: decisionId, prompt, intent });
        let decision = choose(claim.decision, choice);
        if (
          claim.decision.outcome === "unsure" &&
          decision.outcome === "new-thread" &&
          decision.sectionId
        )
          decision = await router.resolveCandidate(claim, decision.sectionId);
        return router.execute(decision, prompt, "router", {
          execution: (execution ?? undefined) as NonNullable<
            Parameters<Router["execute"]>[3]
          >["execution"],
          claim,
        });
      }),
    draftIdentity: async ({ draftKey, text, identity }) => {
      const started = drafts.report(draftKey, text, identity);
      if (!started) return { filed: false };
      try {
        fileComposedIdentity(started.threadId, identity);
        triggerCoordinator(10);
      } catch (error: unknown) {
        bb.log.warn(`Filing a composed thread failed: ${String(error)}`);
      }
      return { filed: true };
    },
    sendToThread: ({ threadId, input, traceId }) =>
      userFacing(() =>
        router.send(threadId, "user", {
          input: input as Parameters<Router["send"]>[2]["input"],
          traceId: traceId ?? null,
        }),
      ),
    recap_get: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const stored = recaps.get(threadId);
      const { capped, corrections } = recaps.capped(threadId);
      const recap = stored?.recap ?? null;
      // Only visible file links need the environment, and an unreadable one
      // leaves them as plain text.
      const environment =
        recap &&
        !stored?.dismissed &&
        recap.links.some((link) => link.location.startsWith("/")) &&
        thread.environmentId
          ? await bb.sdk.environments
              .get({ environmentId: thread.environmentId })
              .catch(() => null)
          : null;
      return {
        recap,
        dismissed: stored?.dismissed ?? false,
        waitingCancelled: stored?.waitingCancelled ?? false,
        capped: capped && thread.status === "idle",
        corrections,
        files: thread.environmentId
          ? {
              environmentId: thread.environmentId,
              root: environment?.path ?? null,
              hostId: environment?.hostId ?? null,
            }
          : null,
      };
    },
    question_at: ({ threadId, interactionId }) =>
      questions.atInteraction(threadId, interactionId),
    question_history: ({ threadId }) => questions.history(threadId),
    question_pending: ({ threadId }) => questions.pending(threadId),
    question_recover: async ({ threadId, id, value, dismiss }) => {
      await questions.recover(threadId, id, value, dismiss);
      return { ok: true as const };
    },
    recap_dismiss: ({ threadId, recapId }) =>
      userFacing(async () => {
        recaps.dismiss(threadId, recapId);
        return { ok: true as const };
      }),
    recap_restore: ({ threadId, recapId }) =>
      userFacing(async () => {
        recaps.restore(threadId, recapId);
        return { ok: true as const };
      }),
    recap_send: ({ threadId, recapId, action }) =>
      userFacing(async () => {
        await recaps.sendNext(threadId, recapId, action);
        return { ok: true as const };
      }),
    recap_agents: async ({ threadIds }) => {
      const threads = await Promise.all(
        threadIds.map((threadId) =>
          bb.sdk.threads.get({ threadId }).catch(() => null),
        ),
      );
      return {
        agents: threads.flatMap((thread) =>
          thread
            ? [
                {
                  threadId: thread.id,
                  projectId: thread.projectId,
                  title:
                    thread.title ??
                    thread.titleFallback ??
                    `Thread ${thread.id.slice(-6)}`,
                  status: thread.status,
                  runtimeStatus: thread.runtime?.displayStatus ?? thread.status,
                  hasPendingInteraction: Boolean(
                    (thread as { hasPendingInteraction?: boolean })
                      .hasPendingInteraction,
                  ),
                  isArchived: thread.archivedAt !== null,
                },
              ]
            : [],
        ),
      };
    },
    catalog: async () => corpus.state(),
    catalogReset: async () => {
      corpus.reset();
      await coordinator.rebuild();
      return { ok: true as const };
    },
    catalogResolve: async ({ entityId }) => {
      const entity = corpus.getById(entityId);
      if (!entity) throw new Error("That corpus identity no longer exists.");
      const groups = corpus.groups();
      const entities = corpus.list();
      const home = activeHome(entityId, [...groups.values()], entities);
      const existing = home
        ? map.list().find((r) => groups.get(r.sectionId) === home)
        : null;
      if (existing)
        return { sectionId: existing.sectionId, name: existing.name };
      return { sectionId: null, name: null };
    },
    catalogCreate: ({ name, description, parentId, aliases }) =>
      userFacing(async () => {
        const entity = corpus.create(
          name,
          description ?? "",
          parentId ?? null,
          aliases ?? [],
        );
        coordinator.trigger();
        notify();
        return { entity };
      }),
    catalogRename: ({ entityId, name }) =>
      userFacing(async () => {
        const entity = corpus.rename(entityId, name);
        coordinator.trigger();
        notify();
        return { entity };
      }),
    catalogReparent: ({ entityId, parentId }) =>
      userFacing(async () => {
        const entity = corpus.reparent(entityId, parentId);
        coordinator.trigger();
        notify();
        return { entity };
      }),
    catalogUpdateMetadata: ({ entityId, description, aliases }) =>
      userFacing(async () => {
        const entity = corpus.updateMetadata(entityId, {
          description,
          aliases,
        });
        coordinator.trigger();
        notify();
        return { entity };
      }),
    catalogMerge: ({ sourceEntityId, targetEntityId }) =>
      userFacing(async () => {
        const result = corpus.merge(sourceEntityId, targetEntityId);
        coordinator.trigger();
        notify();
        return result;
      }),
    taskAssign: ({ threadId, entityId }) =>
      userFacing(async () => {
        await service.reconcile();
        const assignment = corpus.assign(threadId, entityId, {
          provenance: "manual",
        });
        coordinator.trigger();
        notify();
        return { assignment };
      }),
    taskClear: ({ threadId }) =>
      userFacing(async () => {
        await service.reconcile();
        const assignment = corpus.clear(threadId);
        coordinator.trigger();
        notify();
        return { assignment };
      }),
    taskReclassify: ({ threadId, entityId, evidence }) =>
      userFacing(async () => {
        const result = await reclassifyTask({ threadId, entityId, evidence });
        coordinator.trigger();
        return result;
      }),
    taskAssignment: ({ threadId }) =>
      userFacing(async () => {
        await service.reconcile();
        return {
          assignment: corpus.assignment(threadId),
        };
      }),
    state: async () => ({
      ...service.state(),
      workstreams: Object.fromEntries(map.list().map((r) => [r.sectionId, r])),
      analysis: analyzer.all(),
      recaps: recaps.all(),
      driftDismissed: Object.fromEntries(
        (
          db
            .prepare("SELECT thread_id, target FROM ws_drift_dismissed")
            .all() as { thread_id: string; target: string }[]
        ).map((r) => [r.thread_id, r.target]),
      ),
      bootstrapped: coordinator.isDone(),
      organization: coordinator.state(),
      order: loadOrder(db),
      snoozes: snoozes.all(),
      snoozePrefs: loadSnoozePrefs(db),
      catalog: corpus.state(),
    }),
    setSnoozePrefs: async ({ patch }) => {
      const prefs = saveSnoozePrefs(db, patch);
      notify();
      return { prefs };
    },
    snooze: ({ threadId, until }) =>
      userFacing(async () => {
        const now = Date.now();
        if (until !== null && (until <= now || until > now + MAX_SNOOZE_MS))
          throw new UserError("Pick a time in the next year.");
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.archivedAt !== null)
          throw new UserError("Archived threads can't be snoozed.");
        const snooze = snoozes.set(threadId, {
          until,
          attentionAt: thread.latestAttentionAt ?? thread.updatedAt,
          at: now,
        });
        notify();
        return { snooze };
      }),
    unsnooze: async ({ threadId }) => {
      const woke = snoozes.clear(threadId);
      if (woke) notify();
      return { woke };
    },
    reorder: async (change) => {
      const order = saveOrder(db, change);
      notify();
      return { order };
    },
    prefs: async () => ({ prefs: currentPrefs() }),
    setPrefs: async ({ patch }) => {
      const prefs = savePrefs(db, patch);
      bb.realtime.publish("prefs", { prefs });
      notify();
      return { prefs };
    },
    machines: async () => ({
      machines: (await bb.sdk.hosts.list())
        .filter((host) => host.status === "connected")
        .map(({ id, name }) => ({ id, name })),
    }),
    recapPrefs: async () => ({ prefs: loadRecapPrefs(db) }),
    setRecapPrefs: async ({ patch }) => {
      const prefs = saveRecapPrefs(db, patch);
      bb.realtime.publish("recapPrefs", { prefs });
      // Corrections and the card follow at once; the tool follows each
      // session's next start.
      notify();
      return { prefs };
    },
    spinner: async () => ({ spinner: loadSpinner(db) }),
    setSpinner: async ({ spinner }) => {
      const saved = saveSpinner(db, spinner);
      bb.realtime.publish("spinner", { spinner: saved });
      return { spinner: saved };
    },
    drift: ({ threadId, action }) =>
      userFacing(async () => {
        const analysis = analyzer.get(threadId);
        const drift = analysis?.drift;
        const thread = await bb.sdk.threads.get({ threadId });
        // Act only on the flag the user saw: a current, high-confidence result.
        if (
          !analysis ||
          !drift ||
          drift.confidence !== "high" ||
          !isCurrent(analysis, {
            status: thread.status,
            latestAttentionAt: thread.latestAttentionAt ?? thread.updatedAt,
          })
        )
          throw new UserError("This thread has no drift flag right now.");
        const target = analysis.driftSectionId ?? drift.newName ?? "";
        const dismiss = () => {
          db.prepare(
            `INSERT INTO ws_drift_dismissed (thread_id, target, at) VALUES (?, ?, ?)
             ON CONFLICT(thread_id) DO UPDATE SET target = excluded.target, at = excluded.at`,
          ).run(threadId, target, Date.now());
          notify();
        };
        if (action === "dismiss") {
          dismiss();
          return { threadId: null };
        }
        // The drift target as a section: the one analysis named, an existing
        // one with the suggested name, or a new one.
        const sectionFor = async (): Promise<string> => {
          if (analysis.driftSectionId) return analysis.driftSectionId;
          const name = drift.newName ?? "";
          const existing = map
            .list()
            .find((r) => r.name.toLowerCase() === name.toLowerCase());
          if (existing) return existing.sectionId;
          return (await service.createWorkstream(name, "user")).sectionId;
        };
        if (action === "move") {
          const entry = await service.move(
            threadId,
            await sectionFor(),
            "user",
          );
          if (entry)
            inference.link(analysis.traceId, { kind: "entry", ref: entry.id });
          dismiss();
          return { threadId };
        }
        // Hand off: the analyzed turn's request goes to the drift target,
        // under the same policy as `bb workstreams handoff`.
        const [latest] = await bb.sdk.threads.promptHistory({
          threadId,
          limit: "1",
        });
        const request = (latest?.input ?? [])
          .map((part) => ("text" in part ? String(part.text ?? "") : ""))
          .join("\n")
          .trim();
        if (!request) throw new UserError("There's no request to hand off.");
        const decision = await router.route(request, {
          exclude: threadId,
          workstreamId: await sectionFor(),
        });
        const acted = await actOn(
          router,
          {
            ...decision,
            traceId: decision.traceId ?? analysis.traceId ?? null,
          },
          request,
          false,
          "handoff",
          {
            message: `Handed off from @thread:${threadId}. This is now this thread's task; the user continues here, so don't report back there.\n\n${request}`,
            spawnedFrom: threadId,
          },
        );
        dismiss();
        return { threadId: acted.threadId };
      }),
    archiveStatus: ({ threadId }) => archives.status(threadId),
    archive: ({ threadId, recapId }) =>
      userFacing(() => archives.archive(threadId, recapId)),
    organization: async (input) => {
      if (input?.action === "rebuild") {
        const state = await coordinator.rebuild();
        return { state };
      }
      return { state: coordinator.state() };
    },
    journal: async (input) => {
      const entries = journal.list({
        limit: input?.limit,
        before: input?.before,
        external: input?.external,
      });
      const linked = traces.idsFor(
        "entry",
        entries.map((e) => e.id),
      );
      return {
        entries: entries.map((e) => ({
          ...e,
          traceIds: linked.get(e.id) ?? [],
        })),
      };
    },
    undo: ({ entryId }) =>
      userFacing(async () => {
        const entry = await service.undo(entryId);
        map.refresh(service.threads(), analyzer.all());
        return { entry };
      }),
    refresh: async () => {
      const changed = await service.reconcile();
      await sweepSnoozes();
      map.refresh(service.threads(), analyzer.all());
      return { changed };
    },
    traces: async (input) => ({ traces: traces.list(input) }),
    trace: async ({ id }) => ({ trace: traces.get(id) }),
    flagRoute: ({ diagnostics, projectId }) =>
      userFacing(async () => {
        const prefs = currentPrefs();
        if (!prefs.advanced.debug)
          throw new UserError(
            "Enable Debug mode to report a classifier result.",
          );
        const projects = await bb.sdk.projects.list();
        const resolvedProjectId =
          (projectId && projects.some((project) => project.id === projectId)
            ? projectId
            : undefined) ??
          (prefs.newWork.homeProjectId &&
          projects.some((project) => project.id === prefs.newWork.homeProjectId)
            ? prefs.newWork.homeProjectId
            : undefined) ??
          projects[0]?.id;
        if (!resolvedProjectId)
          throw new UserError(
            "No project is available for a classifier report.",
          );
        const sections = await bb.sdk.threadSections.list();
        const existing = sections.find(
          (section) => section.name.toLowerCase() === "workstreams",
        );
        const sectionId =
          existing?.id ??
          (await service.createWorkstream("Workstreams", "user")).sectionId;
        const thread = await bb.sdk.threads.spawn({
          projectId: resolvedProjectId,
          environment: { type: "project-default" },
          sectionId,
          title: "Inaccurate classifier result",
          permissionMode: "accept-edits",
          visibility: "visible",
          prompt: [
            "Triage this potentially inaccurate Workstreams classifier result.",
            "Determine whether the classification or its routing was wrong, identify why, and recommend a concrete correction. Do not change application code or data; report findings only.",
            "",
            "Diagnostics (JSON):",
            diagnostics,
          ].join("\n"),
        });
        service.recordCreated(thread.id, sectionId, "user", {
          title: "Inaccurate classifier result",
          rationale: "Flagged a potentially inaccurate classifier result",
        });
        return { threadId: thread.id, sectionId };
      }),
    traceReplay: ({ id }) =>
      userFacing(async () => ({ trace: await inference.replay(id) })),
    traceClear: async () => ({ removed: traces.clear() }),
  });

  registerCli(bb, {
    arrangement: {
      load: () => loadOrder(db),
      setPrioritized: (ids) => {
        saveOrder(db, { kind: "prioritized", ids });
        notify();
      },
    },
    service,
    journal,
    analyzer,
    recaps,
    coordinator,
    map,
    router,
    traces,
    corpus,
    inference,
    currentPrefs,
    notify,
    reclassifyTask,
  });
}
