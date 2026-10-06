/**
 * Workstreams server entry. Organizes BB threads into workstreams (native
 * sections), records every change in the journal, and reconciles with changes
 * made elsewhere. See SPEC.md.
 */
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerCli } from "./cli.ts";
import { GOAL_MAX } from "../domain/analysis.ts";
import { registerAgentInstructions } from "./agents.ts";
import { Analyzer } from "./analyzer.ts";
import { RecapArchive } from "./archive.ts";
import { Organizer } from "./organizer.ts";
import { sectionMembers } from "./cleanup.ts";
import { WorkstreamMap } from "./map.ts";
import { ComposerPreview, type Preview } from "./preview.ts";
import { TopicStore, topicBasis } from "./topics.ts";
import { ComposedDrafts, type ComposedIdentity } from "./composed-drafts.ts";
import type { TopicAssignment } from "../domain/topics.ts";
import { rpcContract } from "./contract.ts";
import { hostContract } from "./inference/contract.ts";
import { openDatabase } from "./db.ts";
import { Journal } from "./journal.ts";
import { Inference } from "./model.ts";
import { adoptStoredGoals } from "./adopt.ts";
import { QuickAnalysis, type OpeningThread } from "./quick.ts";
import { agentReport, reportedStatus } from "../domain/recap.ts";
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
import { gatewayModel, type ModelChoice } from "../domain/prefs.ts";
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
  let organizer: Organizer | null = null;
  const triggerOrganizer = (debounceMs = 50) => {
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
  const map = new WorkstreamMap(db);
  const topics = new TopicStore(db);
  const projectName = async (projectId: string): Promise<string | null> =>
    (await bb.sdk.projects.list()).find((p) => p.id === projectId)?.name ??
    null;
  /**
   * A topic one of the analyses chose, applied under the source priority;
   * the organizer then files the thread by it.
   */
  const applyTopic = (
    threadId: string,
    answer: Parameters<TopicStore["applyAnalysis"]>[1],
    kind: "full" | "quick",
    basis: string | null,
    traceId: string | null,
  ) => {
    try {
      const changed = topics.applyAnalysis(threadId, answer, kind, basis);
      inference.annotate(traceId, {
        topic: changed ? "applied" : "not applied: the thread keeps its topic",
      });
      if (changed) {
        notify();
        triggerOrganizer();
      }
    } catch (error) {
      bb.log.warn(`Applying a topic to ${threadId} failed: ${String(error)}`);
    }
  };
  // Set below; the analyzer reads recaps only once events start.
  let recaps: AgentRecaps;
  const analyzer = new Analyzer({
    sdk: () => bb.sdk,
    db,
    model: async () => currentPrefs().analysis.fullModel,
    inference,
    report: (threadId) => {
      const recap = recaps.get(threadId)?.recap;
      return recap
        ? { report: agentReport(recap), status: reportedStatus(recap) }
        : null;
    },
    topics: {
      entities: () => topics.list(),
      assignment: (threadId) => topics.assignment(threadId),
      basis: (threadId) => topics.basis(threadId),
      basisOf: (requests, project) => topicBasis({ requests, project }),
      project: projectName,
      apply: (threadId, answer, basis, traceId) =>
        applyTopic(threadId, answer, "full", basis, traceId),
    },
    onChange: notify,
    onResult: (threadId, result) => {
      // A finished analysis can change whether the thread counts as done.
      triggerOrganizer();
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
  const quick = new QuickAnalysis({
    sdk: () => bb.sdk,
    db,
    inference,
    model: async () => currentPrefs().analysis.quickModel,
    enabled: () => currentPrefs().threads.autoTitle,
    analyzed: (threadId) => analyzer.get(threadId) !== undefined,
    apply: (threadId, goal, revision, traceId) =>
      applyGoal(threadId, goal, revision, traceId, "opening"),
    topics: {
      entities: () => topics.list(),
      project: projectName,
      open: (threadId) => topics.assignment(threadId).provenance === null,
      apply: (threadId, answer, traceId) =>
        applyTopic(threadId, answer, "quick", null, traceId),
    },
    log: (message) => bb.log.warn(message),
  });
  bb.onDispose(() => quick.dispose());
  bb.onDispose(() => analyzer.dispose());
  recaps = new AgentRecaps({
    bb,
    db,
    prefs: () => loadRecapPrefs(db),
    since: () => recapToolSince(db),
    onChange: () => {
      notify();
      // A reported or cleared recap can change whether the thread is done.
      triggerOrganizer(200);
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
  const organizerInstance = new Organizer({
    db,
    service,
    topics,
    analyzer,
    recaps: () => recaps.all(),
    policy: () => ({
      capacity: currentPrefs().organize.capacity,
      collapseAt: currentPrefs().organize.collapseAt,
    }),
    members: (sectionId) => sectionMembers(bb.sdk, sectionId),
    journal,
    onChange: notify,
  });
  organizer = organizerInstance;
  bb.onDispose(() => organizerInstance.dispose());
  const previewer = new ComposerPreview({
    sdk: () => bb.sdk,
    topics,
    inference,
    model: async () => currentPrefs().analysis.quickModel,
  });
  // The topic the New thread composer showed, for threads a plain Enter
  // creates without the composer's submit data.
  const drafts = new ComposedDrafts();
  const journaledStarts = new Set<string>();
  /**
   * Gives a composed thread the topic its composer showed: one you picked,
   * the topic of the workstream whose ＋ opened it, or Quick analysis's
   * preview, whose goal also titles it.
   */
  const fileComposedIdentity = (
    thread: OpeningThread,
    identity: ComposedIdentity,
  ) => {
    if (!identity) return;
    const threadId = thread.id;
    if (identity.provenance === "inherited") {
      const topicId = identity.sectionId
        ? topics.groups().get(identity.sectionId)
        : identity.entityId;
      if (topicId && topics.inheritTopic(threadId, topicId)) {
        notify();
        triggerOrganizer(10);
      }
      return;
    }
    if (identity.provenance === "manual") {
      const entity = identity.proposal
        ? topics.rememberProposal(identity.proposal)
        : identity.entityId
          ? topics.getById(identity.entityId)
          : null;
      // A picked topic merged or deleted since leaves the thread to Quick
      // analysis rather than failing.
      if (identity.entityId && !entity) {
        bb.log.warn(`Composed thread ${threadId} names an unknown topic.`);
        return;
      }
      topics.assign(threadId, entity?.id ?? null, { provenance: "manual" });
      notify();
      triggerOrganizer(10);
      return;
    }
    // Quick analysis already ran on this text in the composer.
    quick.onDispatch(
      {
        thread,
        attempt: "start-turn",
        origin: "app",
        input: { text: "" },
      },
      {
        goal: identity.goal ?? null,
        subjectId: identity.entityId ?? null,
        proposed: identity.proposal ?? null,
      },
    );
  };
  /** The thread a new root was started from, when it was. */
  const startedFrom = (ctx: {
    thread: { sourceThreadId?: string | null };
    senderThreadId: string | null;
  }): string | null => ctx.thread.sourceThreadId ?? ctx.senderThreadId ?? null;
  // A new root gets its first topic here (SPEC §6): inherited from the thread
  // or workstream it was started from, the one its composer showed, or Quick
  // analysis's from its first request. The hook itself always proceeds.
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
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
      Date.now() - ctx.thread.createdAt < 10 * 60_000;
    if (!fresh) {
      quick.onDispatch(ctx);
      return { action: "proceed" };
    }
    const ours = ctx.experimental_submission?.pluginId === bb.pluginId;
    const data = ours
      ? (ctx.experimental_submission!.data as {
          identity?: ComposedIdentity;
        } | null)
      : null;
    // Started by a person in BB's New thread view.
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
    const from = ctx.parentThreadId ? null : startedFrom(ctx);
    // Only a composer's own Quick analysis replaces the call made here.
    const preset = identity?.provenance === "automatic" && identity.goal;
    if (!preset) quick.onDispatch(ctx);
    setTimeout(() => {
      try {
        if (journal)
          service.recordCreated(ctx.thread.id, null, "user", {
            title: ctx.thread.title || "New thread",
            rationale: "Started from New thread",
          });
        else service.seeThread(ctx.thread.id, null, ctx.parentThreadId ?? null);
        if (!ctx.parentThreadId) {
          if (from && topics.inherit(ctx.thread.id, from)) notify();
          if (identity) fileComposedIdentity(ctx.thread, identity);
        }
        triggerOrganizer(10);
      } catch (error: unknown) {
        bb.log.warn(`Filing a new thread failed: ${String(error)}`);
      }
    }, 0);
    return { action: "proceed" };
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const reconcileSoon = (delay = RECONCILE_DEBOUNCE_MS) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      service
        .reconcile()
        .then(() => {
          analyzer.catchUp(service.threads());
          quick.sweep(service.threads());
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
          map.refresh(service.threads());
          triggerOrganizer(50);
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
      triggerOrganizer();
    });
  bb.events.on("thread.created", ({ thread }) => {
    if (thread.visibility === "hidden" || thread.archivedAt !== null) return;
    service.seeThread(
      thread.id,
      thread.sectionId ?? null,
      thread.parentThreadId ?? null,
      thread.title ?? thread.titleFallback ?? undefined,
      true,
    );
    // A fork starts with the topic of the thread it was forked from, even
    // before it is sent a message.
    if (
      !thread.parentThreadId &&
      thread.sourceThreadId &&
      topics.inherit(thread.id, thread.sourceThreadId)
    ) {
      notify();
      triggerOrganizer();
    }
  });
  bb.events.on("thread.archived", ({ thread }) => {
    recaps.onArchived(thread.id);
    if (thread.pinnedAt !== null)
      void bb.sdk.threads
        .unpin({ threadId: thread.id })
        .catch((error: unknown) =>
          bb.log.warn(`Unpinning archived thread failed: ${String(error)}`),
        );
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
    quick.forget(thread.id);
    recaps.forget(thread.id);
    service.forget(thread.id);
    topics.forget(thread.id);
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (thread.visibility === "hidden") return;
    analyzer.onIdle(thread, lastAssistantText);
    triggerOrganizer(200);
    return recaps.onIdle(thread.id);
  });
  bb.events.on("thread.active", ({ thread }) => {
    analyzer.onActive(thread.id);
    triggerOrganizer(200);
    // Covers a thread whose first request this run didn't see dispatched.
    void quick.onRunning(thread);
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

  /**
   * Hands a thread's topic back to Workstreams ("Automatic") and settles it
   * now with Full analysis.
   */
  const reclassifyTask = async (input: {
    threadId: string;
  }): Promise<{ assignment: TopicAssignment }> => {
    await service.reconcile();
    const rootId = topics.findRootThread(input.threadId);
    const current = topics.assignment(rootId);
    // Whatever it is now becomes Workstreams' own, to settle afresh.
    topics.assign(rootId, current.entityId, {
      provenance: "full",
      evidence: null,
    });
    notify();
    await analyzer.analyzeNow(rootId);
    triggerOrganizer();
    return { assignment: topics.assignment(input.threadId) };
  };

  bb.rpc.register(rpcContract, {
    preview: ({ prompt, pickedProjectId, draftKey }) =>
      userFacing(async () => {
        const routed = async (signal?: AbortSignal): Promise<Preview> => {
          const prefs = currentPrefs();
          if (!prefs.newWork.suggestions)
            return {
              id: randomUUID(),
              confidence: "low",
              reason: "Suggestions are turned off.",
              subject: null,
              traceId: null,
            };
          const debug = prefs.advanced.debug;
          const notes: string[] = [];
          const started = Date.now();
          const decision = await previewer.preview(prompt, {
            pickedProjectId,
            signal,
            ...(debug ? { explain: (note: string) => notes.push(note) } : {}),
          });
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
    previewCancel: async ({ draftKey }) => ({
      canceled: cancelPreview(draftKey),
    }),
    draftIdentity: async ({ draftKey, text, identity }) => {
      const started = drafts.report(draftKey, text, identity);
      if (!started) return { filed: false };
      try {
        const thread = await bb.sdk.threads.get({ threadId: started.threadId });
        if (!thread.parentThreadId) fileComposedIdentity(thread, identity);
        triggerOrganizer(10);
      } catch (error: unknown) {
        bb.log.warn(`Filing a composed thread failed: ${String(error)}`);
      }
      return { filed: true };
    },
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
    observedNames: async ({ threadId }) => analyzer.observedNames(threadId),
    catalog: async () => topics.state(),
    catalogCreate: ({ name, description, parentId, aliases }) =>
      userFacing(async () => {
        const entity = topics.create(
          name,
          description ?? "",
          parentId ?? null,
          aliases ?? [],
        );
        organizerInstance.trigger();
        notify();
        return { entity };
      }),
    catalogRename: ({ entityId, name }) =>
      userFacing(async () => {
        const entity = topics.rename(entityId, name);
        organizerInstance.trigger();
        notify();
        return { entity };
      }),
    catalogReparent: ({ entityId, parentId }) =>
      userFacing(async () => {
        const entity = topics.reparent(entityId, parentId);
        organizerInstance.trigger();
        notify();
        return { entity };
      }),
    catalogUpdateMetadata: ({ entityId, description, aliases }) =>
      userFacing(async () => {
        const entity = topics.updateMetadata(entityId, {
          description,
          aliases,
        });
        organizerInstance.trigger();
        notify();
        return { entity };
      }),
    catalogMerge: ({ sourceEntityId, targetEntityId }) =>
      userFacing(async () => {
        const result = topics.merge(sourceEntityId, targetEntityId);
        organizerInstance.trigger();
        notify();
        return result;
      }),
    taskAssign: ({ threadId, entityId }) =>
      userFacing(async () => {
        await service.reconcile();
        const assignment = topics.assign(threadId, entityId, {
          provenance: "manual",
        });
        organizerInstance.trigger();
        notify();
        return { assignment };
      }),
    taskReclassify: ({ threadId }) =>
      userFacing(async () => reclassifyTask({ threadId })),
    state: async () => ({
      ...service.state(),
      workstreams: Object.fromEntries(map.list().map((r) => [r.sectionId, r])),
      analysis: analyzer.all(),
      recaps: recaps.all(),
      bootstrapped: organizerInstance.isDone(),
      organization: organizerInstance.state(),
      order: loadOrder(db),
      snoozes: snoozes.all(),
      snoozePrefs: loadSnoozePrefs(db),
      catalog: topics.state(),
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
    archiveStatus: ({ threadId }) => archives.status(threadId),
    archive: ({ threadId, recapId }) =>
      userFacing(() => archives.archive(threadId, recapId)),
    organization: async (input) => {
      if (input?.action === "rebuild") {
        const state = await organizerInstance.rebuild();
        return { state };
      }
      return { state: organizerInstance.state() };
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
        map.refresh(service.threads());
        return { entry };
      }),
    refresh: async () => {
      const changed = await service.reconcile();
      await sweepSnoozes();
      map.refresh(service.threads());
      return { changed };
    },
    traces: async (input) => ({ traces: traces.list(input) }),
    trace: async ({ id }) => ({ trace: traces.get(id) }),
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
    organizer: organizerInstance,
    map,
    traces,
    topics,
    inference,
    currentPrefs,
    notify,
    reclassifyTask,
  });
}
