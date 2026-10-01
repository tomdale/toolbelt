/**
 * Workstreams server entry. Organizes BB threads into workstreams (native
 * sections), records every change in the journal, and reconciles with changes
 * made elsewhere. See SPEC.md.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { actOn, registerCli } from "./cli.ts";
import { isCurrent } from "../domain/analysis.ts";
import { refreshShapes, registerAgentInstructions } from "./agents.ts";
import { Analyzer } from "./analyzer.ts";
import { RecapArchive } from "./archive.ts";
import { Bootstrap } from "./bootstrap.ts";
import { sectionMembers } from "./cleanup.ts";
import { WorkstreamMap } from "./map.ts";
import { Router, type RouteDecision } from "./router.ts";
import { rpcContract } from "./contract.ts";
import { hostContract } from "./inference/contract.ts";
import { openDatabase } from "./db.ts";
import { Journal } from "./journal.ts";
import { Inference } from "./model.ts";
import { loadOrder, saveOrder } from "./order.ts";
import { loadSpinner, saveSpinner } from "./spinner.ts";
import { UserError, WorkstreamService } from "./service.ts";
import { TraceStore } from "./trace.ts";
import { AgentRecaps } from "./recap.ts";
import { loadRecapPrefs, saveRecapPrefs } from "./recapPrefs.ts";
import { ThreadSnoozes, loadSnoozePrefs, saveSnoozePrefs } from "./snooze.ts";

export { rpcContract } from "./contract.ts";

const RECONCILE_EVERY_MS = 60_000;
const RECONCILE_DEBOUNCE_MS = 1_500;

/**
 * Models that pass the analysis eval (eval/README.md, SPEC §10); the first is
 * the default. Add one only after it passes.
 */
export const MODELS = ["google/gemini-3.1-flash-lite"] as const;
/** Bounded organizing uses Flash-Lite by default; callers can opt into a stronger model. */
export const ORGANIZE_MODELS = [
  "google/gemini-3.1-flash-lite",
  "openai/gpt-6-sol-fast",
] as const;
/** The furthest out a snooze can wake. */
const MAX_SNOOZE_MS = 366 * 24 * 60 * 60 * 1000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    showParentThreadLink: {
      type: "boolean",
      label: "Show parent thread link in thread header",
      description:
        "Show a link to the parent thread in the header of child threads.",
      default: false,
    },
    showForYou: {
      type: "boolean",
      label: "Show the For you section in the sidebar",
      description:
        "Threads waiting on you: an open approval or question, or a decision the thread asked for.",
      default: true,
    },
    showRecent: {
      type: "boolean",
      label: "Show the Recent band in the sidebar",
      description:
        "The five most recently active threads, excluding ones already in For you.",
      default: true,
    },
    model: {
      type: "select",
      label: "Analysis model",
      description: "Summarizes each thread after every turn.",
      options: [...MODELS],
      default: MODELS[0],
    },
    autoTitle: {
      type: "boolean",
      label: "Keep thread titles current",
      description:
        "Title untitled threads, and retitle a thread when its work moves on. Titles you set yourself are never changed.",
      default: true,
    },
    hostId: {
      type: "string",
      label: "Analysis machine ID",
      description:
        "The machine whose Pi runs analysis. Blank uses the only connected machine.",
      default: "",
    },
    organizeModel: {
      type: "select",
      label: "Organizing model",
      description:
        "Proposes the workstream map and files threads when you organize, once.",
      options: [...ORGANIZE_MODELS],
      default: ORGANIZE_MODELS[0],
    },
    homeProjectId: {
      type: "project",
      label: "Home project",
      description:
        'Where work with no code target starts. Blank starts it in a fresh personal workspace ("Don\'t work in a project").',
      default: "",
    },
    debug: {
      type: "boolean",
      label: "Debug mode",
      description:
        "Record every model call's prompt, reasoning, and response, and show an inspect button wherever Workstreams used a model. Records include redacted thread excerpts and are kept for 7 days.",
      default: false,
    },
  });

  const db = openDatabase(bb);
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

  const hostRpc = bb.hosts.experimental_client({ contract: hostContract });
  const analysisHost = async (): Promise<string> => {
    const connected = (await bb.sdk.hosts.list()).filter(
      (host) => host.status === "connected",
    );
    const { hostId } = await settings.get();
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
  const traces = new TraceStore(db);
  const inference = new Inference({
    complete: async (prompt, model, signal, maxTokens) =>
      hostRpc.call(
        "complete",
        { prompt, model, ...(maxTokens ? { maxTokens } : {}) },
        { hostId: await analysisHost(), timeoutMs: 95_000, signal },
      ),
    traces,
    debug: async () => (await settings.get()).debug === true,
    log: (message) => bb.log.warn(message),
  });
  // Retention also applies while Debug mode is off and nothing is recorded.
  traces.prune({ force: true });
  const analyzer = new Analyzer({
    sdk: () => bb.sdk,
    db,
    model: async () => (await settings.get()).model,
    inference,
    onChange: notify,
    onResult: (threadId, result) => {
      if (!result.title) return;
      void settings
        .get()
        .then(async ({ autoTitle }) => {
          if (!autoTitle) {
            inference.annotate(result.traceId, {
              title: "not applied: the autoTitle setting is off",
            });
            return;
          }
          const { entry, skipped } = await service.retitle(
            threadId,
            result.title,
            result.revision,
          );
          if (entry)
            inference.link(result.traceId, { kind: "entry", ref: entry.id });
          inference.annotate(result.traceId, {
            title: entry ? "applied" : `not applied: ${skipped}`,
          });
        })
        .catch((error: unknown) =>
          bb.log.warn(`Retitling ${threadId} failed: ${String(error)}`),
        );
    },
    log: (message) => bb.log.warn(message),
    info: (message) => bb.log.info(message),
  });
  bb.onDispose(() => analyzer.dispose());
  const recaps = new AgentRecaps({
    bb,
    db,
    prefs: () => loadRecapPrefs(db),
    onChange: notify,
  });
  recaps.register();
  bb.onDispose(() => recaps.dispose());
  const archives = new RecapArchive({
    sdk: () => bb.sdk,
    recaps,
    analyzer,
    onChange: notify,
  });
  registerAgentInstructions(bb, db, recaps);
  const map = new WorkstreamMap(db);
  const bootstrap = new Bootstrap({
    db,
    service,
    analyzer,
    map,
    inference,
    model: async () => (await settings.get()).organizeModel,
    projects: async () => bb.sdk.projects.list(),
    members: (sectionId) => sectionMembers(bb.sdk, sectionId),
    onChange: notify,
  });
  bb.onDispose(() => bootstrap.dispose());
  const router = new Router({
    sdk: () => bb.sdk,
    service,
    journal,
    map,
    analyzer,
    inference,
    model: async () => (await settings.get()).model,
    homeProjectId: async () => (await settings.get()).homeProjectId ?? "",
  });
  // A thread the native composer just created from a previewed prompt is
  // filed where the preview said: via the banner's submit data, or, for a
  // plain Enter, by matching the prompt. The hook itself always proceeds.
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const correction = recaps.onDispatch(ctx);
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
      !ctx.parentThreadId &&
      Date.now() - ctx.thread.createdAt < 10 * 60_000;
    if (fresh) {
      const metadata = await bb.sdk.threads.getPluginMetadata({
        threadId: ctx.thread.id,
      });
      if (metadata.unassignedByRouter === true) return { action: "proceed" };
      const data =
        ctx.experimental_submission?.pluginId === bb.pluginId
          ? (ctx.experimental_submission.data as { routeId?: string } | null)
          : null;
      const decision = router.recall({
        id: data?.routeId ?? null,
        prompt: ctx.input.text,
      });
      if (decision)
        setTimeout(() => {
          router
            .fileComposed(ctx.thread.id, decision)
            .catch((error: unknown) =>
              bb.log.warn(`Filing a composed thread failed: ${String(error)}`),
            );
        }, 0);
    }
    return { action: "proceed" };
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
          void sweepSnoozes();
          void refreshShapes(bb.sdk, db, async (hostId, path) =>
            hostRpc.call("probe", { path }, { hostId, timeoutMs: 15_000 }),
          ).catch((error: unknown) =>
            bb.log.warn(`Project shape check failed: ${String(error)}`),
          );
          map.refresh(service.threads(), analyzer.all());
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
  bb.events.on("interaction.pending", ({ thread, interaction }) =>
    recaps.onInteractionPending(thread.id, interaction),
  );
  bb.events.on("thread.deleted", ({ thread }) => {
    snoozes.clear(thread.id);
    analyzer.forget(thread.id);
    recaps.forget(thread.id);
    service.forget(thread.id);
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (thread.visibility === "hidden") return;
    analyzer.onIdle(thread, lastAssistantText);
    return recaps.onIdle(thread.id);
  });
  bb.events.on("thread.active", ({ thread }) => {
    analyzer.onActive(thread.id);
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

  bb.rpc.register(rpcContract, {
    route: ({
      prompt,
      pickedProjectId,
      workstreamId,
      intent,
      offerNewThread,
      suggest,
      fromDecisionId,
      draftKey,
    }) =>
      userFacing(async () => {
        const options = {
          pickedProjectId,
          workstreamId,
          intent,
          offerNewThread,
          suggest,
          fromDecisionId,
        };
        const routed = async (signal?: AbortSignal) => {
          const decision = await router.route(prompt, { ...options, signal });
          // A suggestion is accepted through its own RPCs. Remembering it
          // would let BB's composer file an unrelated thread with this text.
          if (suggest) {
            router.forget(decision.id);
            if (decision.outcome === "continue" && decision.alternative)
              router.forget(decision.alternative.id);
          }
          return decision;
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
    startThread: ({ sectionId, execution }) =>
      userFacing(() =>
        router.start(
          sectionId,
          execution as unknown as Parameters<Router["start"]>[1],
        ),
      ),
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
      return {
        recap: stored && !stored.dismissed ? stored.recap : null,
        capped: capped && thread.status === "idle",
        corrections,
        environmentId: thread.environmentId,
      };
    },
    recap_dismiss: ({ threadId, recapId }) =>
      userFacing(async () => {
        recaps.dismiss(threadId, recapId);
        return { ok: true as const };
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
      bootstrapped: bootstrap.isDone(),
      order: loadOrder(db),
      snoozes: snoozes.all(),
      snoozePrefs: loadSnoozePrefs(db),
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
    editWorkstream: ({ sectionId, description, aliases }) =>
      userFacing(async () => {
        const record = map.get(sectionId);
        if (!record) throw new UserError("That workstream no longer exists.");
        map.edit(sectionId, { description, aliases });
        journal.add({
          action: "edit-workstream",
          source: "user",
          rationale: `Edited ${record.name}'s ${description !== undefined ? "description" : "aliases"}`,
          threads: [],
          workstreams: [{ id: sectionId, name: record.name }],
          undo: null,
        });
        notify();
        return { ok: true as const };
      }),
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
    bootstrap: (input) =>
      userFacing(async () => {
        // Model steps take seconds and report progress over realtime; a
        // refusal (already running, nothing to apply) still reaches the caller.
        const settle = async (work: Promise<unknown>) => {
          let refusal: unknown = null;
          const done = work.then(
            () => undefined,
            (error: unknown) => {
              if (error instanceof UserError) refusal = error;
              else bb.log.warn(`Organizing failed: ${String(error)}`);
            },
          );
          await Promise.race([
            done,
            new Promise((resolve) => setTimeout(resolve, 300)),
          ]);
          if (refusal) throw refusal;
        };
        if (input.action === "start") await settle(bootstrap.start());
        else if (input.action === "apply")
          await settle(bootstrap.apply(input.overrides, input.runId));
        else if (input.action === "cancel") bootstrap.cancel();
        return { state: bootstrap.state(), bootstrapped: bootstrap.isDone() };
      }),
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
    moveThread: ({ threadId, sectionId }) =>
      userFacing(async () => ({
        entry: await service.move(threadId, sectionId, "user"),
      })),
    createWorkstream: ({ name, description, threadId }) =>
      userFacing(async () => {
        const created = await service.createWorkstream(name, "user");
        if (description?.trim())
          map.describe(created.sectionId, description.trim());
        if (threadId) await service.move(threadId, created.sectionId, "user");
        return created;
      }),
    renameWorkstream: ({ sectionId, name }) =>
      userFacing(async () => ({
        entry: await service.renameWorkstream(sectionId, name, "user"),
      })),
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
    traceReplay: ({ id }) =>
      userFacing(async () => ({ trace: await inference.replay(id) })),
    traceClear: async () => ({ removed: traces.clear() }),
  });

  registerCli(bb, {
    service,
    journal,
    analyzer,
    recaps,
    bootstrap,
    map,
    router,
    traces,
  });
}
