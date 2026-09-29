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
import { Bootstrap } from "./bootstrap.ts";
import { Evolution } from "./evolution.ts";
import { WorkstreamMap } from "./map.ts";
import { Router, type RouteDecision } from "./router.ts";
import { rpcContract } from "./contract.ts";
import { hostContract } from "./inference/contract.ts";
import { openDatabase } from "./db.ts";
import { Journal } from "./journal.ts";
import { UserError, WorkstreamService } from "./service.ts";

export { rpcContract } from "./contract.ts";

const RECONCILE_EVERY_MS = 60_000;
const RECONCILE_DEBOUNCE_MS = 1_500;

/**
 * Models that pass the analysis eval (eval/README.md, SPEC §10); the first is
 * the default. Add one only after it passes.
 */
export const MODELS = ["google/gemini-3.1-flash-lite"] as const;
/** Stronger fast models for the one-time assignment (SPEC D7). */
export const ORGANIZE_MODELS = [
  "openai/gpt-6-sol-fast",
  "google/gemini-3.1-flash-lite",
] as const;
const EVOLVE_DEBOUNCE_MS = 15_000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    showParentThreadLink: {
      type: "boolean",
      label: "Show parent thread link in thread header",
      description:
        "Show a link to the parent thread in the header of child threads.",
      default: false,
    },
    showRecent: {
      type: "boolean",
      label: "Show the Recent band in the sidebar",
      description:
        "The five most recently active threads, excluding ones already in Needs you.",
      default: true,
    },
    model: {
      type: "select",
      label: "Analysis model",
      description: "Summarizes each thread after every turn.",
      options: [...MODELS],
      default: MODELS[0],
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
    evolution: {
      type: "select",
      label: "Workstream changes",
      description:
        "When threads show a workstream should split, merge, or move: apply the change with an Undo banner, or ask first.",
      options: ["auto", "ask"],
      default: "auto",
    },
    homeProjectId: {
      type: "project",
      label: "Home project",
      description:
        'Where work with no code target starts. Blank starts it in a fresh personal workspace ("Don\'t work in a project").',
      default: "",
    },
    sensitivity: {
      type: "select",
      label: "Change sensitivity",
      description:
        "How much shared work proposes a new workstream: responsive (2 threads), balanced (3), or conservative (4).",
      options: ["responsive", "balanced", "conservative"],
      default: "responsive",
    },
  });

  const db = openDatabase(bb);
  const journal = new Journal(db);
  const notify = () => bb.realtime.publish("changed", {});
  const service = new WorkstreamService(() => bb.sdk, db, journal, notify);

  const inference = bb.hosts.experimental_client({ contract: hostContract });
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
  const complete = async (prompt: string, model: string) =>
    inference.call(
      "complete",
      { prompt, model },
      { hostId: await analysisHost(), timeoutMs: 95_000 },
    );
  let evolveSoon = () => {};
  const analyzer = new Analyzer({
    sdk: () => bb.sdk,
    db,
    model: async () => (await settings.get()).model,
    complete,
    onChange: () => {
      notify();
      evolveSoon();
    },
    log: (message) => bb.log.warn(message),
    info: (message) => bb.log.info(message),
  });
  bb.onDispose(() => analyzer.dispose());
  registerAgentInstructions(bb, db);
  const map = new WorkstreamMap(db);
  const bootstrap = new Bootstrap({
    db,
    service,
    analyzer,
    map,
    complete,
    model: async () => (await settings.get()).organizeModel,
    onChange: notify,
  });
  const evolution = new Evolution({
    sdk: () => bb.sdk,
    db,
    service,
    journal,
    map,
    analyzer,
    bootstrap,
    complete,
    model: async () => (await settings.get()).model,
    settings: async () => {
      const values = await settings.get();
      return { evolution: values.evolution, sensitivity: values.sensitivity };
    },
    onChange: notify,
    log: (message) => bb.log.warn(message),
  });
  const router = new Router({
    sdk: () => bb.sdk,
    service,
    journal,
    map,
    analyzer,
    complete,
    model: async () => (await settings.get()).model,
    homeProjectId: async () => (await settings.get()).homeProjectId ?? "",
  });
  // A thread the native composer just created from a previewed prompt is
  // filed where the preview said: via the banner's submit data, or, for a
  // plain Enter, by matching the prompt. The hook itself always proceeds.
  bb.experimental_hooks.on("message.dispatch", (ctx) => {
    // A thread's first message has an origin; follow-ups, steers, and retries
    // don't. Queued re-attempts of a first message still count.
    const fresh =
      ctx.origin !== null &&
      ctx.attempt === "start-turn" &&
      !ctx.thread.sectionId &&
      !ctx.parentThreadId &&
      Date.now() - ctx.thread.createdAt < 10 * 60_000;
    if (fresh) {
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
          placement: {
            projectId: "",
            environment: { type: "project-default" },
            label: "",
          },
        };
  };
  let evolveTimer: ReturnType<typeof setTimeout> | null = null;
  evolveSoon = () => {
    if (evolveTimer) return;
    evolveTimer = setTimeout(() => {
      evolveTimer = null;
      void evolution.tick();
    }, EVOLVE_DEBOUNCE_MS);
  };
  bb.onDispose(() => {
    if (evolveTimer) clearTimeout(evolveTimer);
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
          void refreshShapes(bb.sdk, db, async (hostId, path) =>
            inference.call("probe", { path }, { hostId, timeoutMs: 15_000 }),
          ).catch((error: unknown) =>
            bb.log.warn(`Project shape check failed: ${String(error)}`),
          );
          return evolution.tick();
        })
        .catch((error: unknown) =>
          bb.log.warn(`Reconcile failed: ${String(error)}`),
        );
    }, delay);
  };
  const interval = setInterval(() => reconcileSoon(0), RECONCILE_EVERY_MS);
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
  bb.events.on("thread.created", ({ thread }) => {
    if (thread.visibility !== "hidden" && thread.archivedAt === null)
      service.seeThread(
        thread.id,
        thread.sectionId ?? null,
        thread.parentThreadId ?? null,
        thread.title ?? thread.titleFallback ?? undefined,
        true,
      );
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    analyzer.forget(thread.id);
    service.forget(thread.id);
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (thread.visibility !== "hidden")
      analyzer.onIdle(thread, lastAssistantText);
  });
  bb.events.on("thread.active", ({ thread }) => analyzer.onActive(thread.id));

  const userFacing = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof UserError) throw new Error(error.message);
      throw error;
    }
  };

  bb.rpc.register(rpcContract, {
    route: ({ prompt, pickedProjectId, workstreamId }) =>
      userFacing(() => router.route(prompt, { pickedProjectId, workstreamId })),
    routeExecute: ({ decisionId, prompt, choice, execution }) =>
      userFacing(async () => {
        const remembered = router.recall({ id: decisionId, prompt });
        if (!remembered)
          throw new UserError("That preview expired; route it again.");
        let decision = choose(remembered, choice);
        // Claim the preview before resolving an ambiguous placement, which
        // yields and could otherwise let a second submit consume it too.
        router.forget(decisionId);
        // An unsure choice of workstream still needs a real placement.
        if (decision.outcome === "new-thread" && !decision.placement.projectId)
          decision = await router.route(
            `@section:${decision.sectionId} ${prompt}`,
          );
        return router.execute(decision, prompt, "router", {
          execution: (execution ?? undefined) as never,
        });
      }),
    state: async () => ({
      ...service.state(),
      workstreams: Object.fromEntries(map.list().map((r) => [r.sectionId, r])),
      analysis: analyzer.all(),
      proposals: evolution.proposals(),
      driftDismissed: Object.fromEntries(
        (
          db
            .prepare("SELECT thread_id, target FROM ws_drift_dismissed")
            .all() as { thread_id: string; target: string }[]
        ).map((r) => [r.thread_id, r.target]),
      ),
      bootstrapped: bootstrap.isDone(),
    }),
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
          await service.move(threadId, await sectionFor(), "user");
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
        const acted = await actOn(router, decision, request, false, "handoff", {
          message: `Handed off from @thread:${threadId}. This is now this thread's task; the user continues here, so don't report back there.\n\n${request}`,
          spawnedFrom: threadId,
        });
        dismiss();
        return { threadId: acted.threadId };
      }),
    proposal: ({ id, action }) =>
      userFacing(async () => {
        if (action === "accept") await evolution.accept(id);
        else if (action === "dismiss") evolution.dismiss(id);
        else evolution.acknowledge(id);
        return { ok: true as const };
      }),
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
        else if (input.action === "assign")
          await settle(bootstrap.assign(input.decisions));
        else if (input.action === "apply")
          await settle(bootstrap.apply(input.overrides));
        else if (input.action === "skip") bootstrap.skip();
        else if (input.action === "cancel") bootstrap.cancel();
        return { state: bootstrap.state(), bootstrapped: bootstrap.isDone() };
      }),
    journal: async (input) => ({
      entries: journal.list({
        limit: input?.limit,
        before: input?.before,
        external: input?.external,
      }),
    }),
    moveThread: ({ threadId, sectionId }) =>
      userFacing(async () => ({
        entry: await service.move(threadId, sectionId, "user"),
      })),
    createWorkstream: ({ name, threadId }) =>
      userFacing(async () => {
        const created = await service.createWorkstream(name, "user");
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
        evolution.settleUndone();
        return { entry };
      }),
    refresh: async () => {
      const changed = await service.reconcile();
      await evolution.tick();
      return { changed };
    },
  });

  registerCli(bb, service, journal, analyzer, bootstrap, map, router);
}
