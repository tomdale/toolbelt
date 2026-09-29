/**
 * Workstreams server entry. Organizes BB threads into workstreams (native
 * sections), records every change in the journal, and reconciles with changes
 * made elsewhere. See SPEC.md.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerCli } from "./cli.ts";
import { Analyzer } from "./analyzer.ts";
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
      description:
        "Summarizes each thread after every turn through Pi's AI Gateway. Change it only to a model that passes the eval.",
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
  const analyzer = new Analyzer({
    sdk: () => bb.sdk,
    db,
    model: async () => (await settings.get()).model,
    complete: async (prompt, model) =>
      inference.call(
        "complete",
        { prompt, model },
        { hostId: await analysisHost(), timeoutMs: 95_000 },
      ),
    onChange: notify,
    log: (message) => bb.log.warn(message),
    info: (message) => bb.log.info(message),
  });
  bb.onDispose(() => analyzer.dispose());

  let timer: ReturnType<typeof setTimeout> | null = null;
  const reconcileSoon = (delay = RECONCILE_DEBOUNCE_MS) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      service
        .reconcile()
        .then(() => analyzer.catchUp(service.threads()))
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
    state: async () => ({ ...service.state(), analysis: analyzer.all() }),
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
      userFacing(async () => ({ entry: await service.undo(entryId) })),
    refresh: async () => ({ changed: await service.reconcile() }),
  });

  registerCli(bb, service, journal, analyzer);
}
