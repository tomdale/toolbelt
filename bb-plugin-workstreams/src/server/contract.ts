import { defineRpcContract } from "@get-bb/plugin-sdk";
import { questionHistorySchema } from "./questions/history.ts";
import {
  interactionPayloadSchema,
  interactionResponseSchema,
} from "./questions/contracts.ts";
import { z } from "zod";
import { WORK_STATES } from "../domain/analysis.ts";
import { prefsPatchSchema, prefsSchema } from "../domain/prefs.ts";
import { recapPrefsSchema } from "../domain/recapPrefs.ts";
import { recapSchema } from "../domain/recap.ts";
import { snoozePrefsPatchSchema, snoozePrefsSchema } from "../domain/snooze.ts";
import {
  HEX_COLOR,
  SPINNER_COLORS,
  SPINNER_SHAPES,
} from "../domain/spinner.ts";
import {
  TRACE_KINDS,
  linkSchema,
  traceSchema,
  traceSummarySchema,
} from "../domain/trace.ts";
import type { Environment } from "./router.ts";
import { entrySchema, sourceSchema } from "./journal.ts";
import { organizeProposalSchema } from "../domain/organize.ts";

const placementSchema = z.object({
  sectionId: z.string().nullable(),
  source: sourceSchema,
  at: z.number(),
  entryId: z.string().nullable(),
});

const analysisSchema = z.object({
  recap: z.string(),
  state: z.enum(WORK_STATES),
  needsYou: z.string().nullable(),
  subject: z.string().nullable(),
  // Results stored before titles were suggested have none.
  title: z.string().nullable().default(null),
  drift: z
    .object({
      workstream: z.string().nullable(),
      newName: z.string().nullable(),
      confidence: z.enum(["high", "medium", "low"]),
    })
    .nullable(),
  driftSectionId: z.string().nullable(),
  revision: z.number(),
  at: z.number(),
  model: z.string(),
  traceId: z.string().nullable().default(null),
});

const recordSchema = z.object({
  sectionId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  descriptionSource: z.enum(["generated", "user"]),
  aliases: z.array(z.string()),
  subjects: z.array(z.string()),
  projects: z.array(
    z.object({
      projectId: z.string(),
      role: z.enum(["primary", "secondary"]),
      environment: z.enum(["checkout", "worktree"]),
    }),
  ),
  evidence: z.object({ threadCount: z.number(), lastActiveAt: z.number() }),
  createdBy: z.enum(["user", "workstreams"]),
  updatedAt: z.number(),
});

const moveSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  from: z.string().nullable(),
  fromName: z.string(),
  to: z.string().nullable(),
  toName: z.string(),
  reason: z.string(),
  accepted: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  traceId: z.string().nullable().optional(),
});

const bootstrapSchema = z
  .object({
    status: z.enum(["proposing", "preview", "applying", "applied", "failed"]),
    startedAt: z.number(),
    updatedAt: z.number(),
    error: z.string().nullable(),
    roots: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        sectionId: z.string().nullable(),
      }),
    ),
    mapSnapshot: z.array(
      z.object({
        sectionId: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        aliases: z.array(z.string()),
        descriptionSource: z.enum(["user", "generated"]),
      }),
    ),
    preview: z
      .object({
        workstreams: z
          .array(
            organizeProposalSchema.shape.workstreams.element.extend({
              description: z.string().max(300),
            }),
          )
          .max(100),
        assignments: organizeProposalSchema.shape.assignments,
        removals: z.array(
          z.object({
            sectionId: z.string(),
            name: z.string(),
            latestArchivedAt: z.number().nullable(),
            archivedThreads: z.array(
              z.object({ id: z.string(), archivedAt: z.number() }),
            ),
          }),
        ),
        creates: z.array(
          z.object({ name: z.string(), description: z.string() }),
        ),
        renames: z.array(
          z.object({ sectionId: z.string(), from: z.string(), to: z.string() }),
        ),
        moves: z.array(moveSchema),
      })
      .nullable(),
    entryId: z.string().nullable(),
    traceIds: z.array(z.string()).default([]),
  })
  .nullable();

const idList = z.array(z.string().min(1)).max(5000);
const spinnerColorSchema = z.union([
  z.enum(SPINNER_COLORS),
  z.string().regex(HEX_COLOR) as z.ZodType<`#${string}`>,
]);
const spinnerSchema = z.object({
  shape: z.enum(SPINNER_SHAPES),
  primary: spinnerColorSchema,
  secondary: z.union([spinnerColorSchema, z.enum(["auto", "none"])]),
});

const snoozeSchema = z.object({
  until: z.number().nullable(),
  attentionAt: z.number(),
  at: z.number(),
});

const orderSchema = z.object({
  workstreams: z.array(z.string()),
  threads: z.record(z.string(), z.array(z.string())),
  prioritized: z.array(z.string()),
});

const routeBase = {
  id: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
  subject: z.string().nullable(),
  traceId: z.string().nullable(),
  explanation: z
    .object({ notes: z.array(z.string()), durationMs: z.number() })
    .optional(),
};
/** The supported SDK environment selection union, validated before routing or execution. */
export const environmentSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("reuse"),
    environmentId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("host"),
    hostId: z.string().min(1).optional(),
    workspace: z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("unmanaged"),
        path: z.string().nullable(),
        branch: z
          .discriminatedUnion("kind", [
            z.strictObject({
              kind: z.literal("existing"),
              name: z.string().min(1),
            }),
            z.strictObject({
              kind: z.literal("new"),
              baseBranch: z.string().min(1),
            }),
          ])
          .optional(),
      }),
      z.strictObject({
        type: z.literal("managed-worktree"),
        baseBranch: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("default") }),
          z.strictObject({ kind: z.literal("named"), name: z.string().min(1) }),
        ]),
      }),
      z.strictObject({ type: z.literal("personal") }),
    ]),
  }),
  z.strictObject({ type: z.literal("project-default") }),
  z.strictObject({
    type: z.literal("provider"),
    environmentProviderId: z.string().min(1),
    inputs: z.json().nullable().default(null),
    machine: z
      .discriminatedUnion("type", [
        z.strictObject({
          type: z.literal("existing"),
          hostId: z.string().min(1),
        }),
        z.strictObject({
          type: z.literal("new"),
          machineProviderId: z.string().min(1),
          inputs: z.json().nullable().default(null),
        }),
      ])
      .optional(),
  }),
]) satisfies z.ZodType<Environment>;

const placementSchema2 = z.object({
  projectId: z.string(),
  environment: environmentSchema,
  label: z.string(),
});
export const routeIntentSchema = z.object({
  action: z.enum(["new-thread", "send-message", "new-workstream"]).optional(),
  destination: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("workstream"), id: z.string() }),
      z.object({ kind: z.literal("thread"), id: z.string() }),
      z.object({ kind: z.literal("none") }),
    ])
    .optional(),
  placement: z
    .object({
      projectId: z.string().optional(),
      environment: environmentSchema.optional(),
    })
    .optional(),
  workstreamName: z.string().optional(),
});
const newThreadRouteSchema = z.object({
  ...routeBase,
  outcome: z.literal("new-thread"),
  sectionId: z.string().nullable(),
  workstream: z.string().nullable(),
  title: z.string(),
  placement: placementSchema2.nullable(),
});
export const routeSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...routeBase,
    outcome: z.literal("continue"),
    threadId: z.string(),
    threadTitle: z.string(),
    workstream: z.string().nullable(),
    sectionId: z.string().nullable(),
    alternative: newThreadRouteSchema.optional(),
  }),
  newThreadRouteSchema,
  z.object({
    ...routeBase,
    outcome: z.literal("new-workstream"),
    name: z.string(),
    description: z.string(),
    title: z.string(),
    placement: placementSchema2.nullable(),
  }),
  z.object({
    ...routeBase,
    outcome: z.literal("unsure"),
    candidates: z.array(
      z.union([
        z.object({
          kind: z.literal("thread"),
          threadId: z.string(),
          title: z.string(),
        }),
        z.object({
          kind: z.literal("workstream"),
          sectionId: z.string(),
          name: z.string(),
        }),
      ]),
    ),
  }),
]);

export const rpcContract = defineRpcContract({
  question_at: {
    input: z.object({
      threadId: z.string().min(1),
      interactionId: z.string().min(1),
    }),
    output: questionHistorySchema.nullable(),
  },
  question_history: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.array(questionHistorySchema),
  },
  question_pending: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z
      .object({
        id: z.string(),
        recoverable: z.boolean(),
        payload: interactionPayloadSchema,
      })
      .nullable(),
  },
  question_recover: {
    input: z.object({
      threadId: z.string().min(1),
      id: z.string().min(1),
      value: interactionResponseSchema.nullable(),
      dismiss: z.boolean(),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  /** Where new work would go (SPEC §6). Changes nothing. */
  route: {
    input: z.object({
      prompt: z.string().min(1).max(20_000),
      pickedProjectId: z.string().nullable().optional(),
      workstreamId: z.string().nullable().optional(),
      /**
       * The workstream New work's field shows: still classified, but the
       * model is told to prefer it. `workstreamId` skips the model instead.
       */
      selectedWorkstreamId: z.string().nullable().optional(),
      intent: routeIntentSchema.nullable().optional(),
      /**
       * When the route continues an inferred thread, also preview the new
       * thread the work would start instead, as its `alternative`.
       */
      offerNewThread: z.boolean().optional(),
      /**
       * New work's suggestion: return the single most likely home, which may
       * be a new workstream, and keep nothing to execute later. Accepting it
       * goes through `startThread`, `sendToThread` and `createWorkstream`.
       */
      suggest: z.boolean().optional(),
      /** Keep this preview available for the native composer dispatch hook. */
      nativeComposer: z.boolean().optional(),
      /**
       * The unsure decision whose candidate `workstreamId` is: its routing
       * call keeps explaining the result (SPEC §11.6).
       */
      fromDecisionId: z.string().nullable().optional(),
      /**
       * The composer draft this preview is for. A newer `route` or a
       * `routeCancel` for the same draft aborts this one's model call.
       */
      draftKey: z.string().min(1).max(500).nullable().optional(),
    }),
    output: routeSchema,
  },
  /**
   * Aborts the in-flight `route` for a draft, because its text changed.
   * Returns whether one was running.
   */
  routeCancel: {
    input: z.object({ draftKey: z.string().min(1).max(500) }),
    output: z.object({ canceled: z.boolean() }),
  },
  /**
   * Acts on a previewed route: sends to the thread, or spawns the thread
   * (with the composer's execution choices when given). `choice` overrides an
   * unsure decision with one of its candidates.
   */
  routeExecute: {
    input: z.object({
      decisionId: z.string().min(1),
      prompt: z.string().min(1).max(20_000),
      choice: z
        .union([
          z.object({ threadId: z.string() }),
          z.object({ sectionId: z.string() }),
        ])
        .nullable()
        .optional(),
      execution: z
        .object({
          projectId: z.string().optional(),
          environment: environmentSchema.optional(),
        })
        .catchall(z.unknown())
        .nullable()
        .optional(),
      intent: routeIntentSchema.nullable().optional(),
    }),
    output: z.object({
      threadId: z.string().nullable(),
      sectionId: z.string().nullable(),
    }),
  },
  /**
   * Starts New work's thread with the composer's resolved request, filed in
   * `sectionId` or deliberately without a workstream.
   */
  startThread: {
    input: z.object({
      sectionId: z.string().min(1).nullable(),
      execution: z
        .object({
          projectId: z.string().min(1),
          environment: environmentSchema,
        })
        .catchall(z.unknown()),
    }),
    output: z.object({
      threadId: z.string(),
      sectionId: z.string().nullable(),
    }),
  },
  /**
   * Queues New work's draft in an existing thread. `traceId` links the
   * routing call that suggested it.
   */
  sendToThread: {
    input: z.object({
      threadId: z.string().min(1),
      input: z.array(z.unknown()).min(1),
      traceId: z.string().nullable().optional(),
    }),
    output: z.object({ threadId: z.string() }),
  },
  /**
   * The recap card's contents: the agent's recap for the thread's latest
   * turn, its dismissal state, and whether corrections ran out without one.
   */
  recap_get: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({
      recap: recapSchema.nullable(),
      dismissed: z.boolean(),
      waitingCancelled: z.boolean(),
      capped: z.boolean(),
      corrections: z.number(),
      /** Where the thread's files live, to resolve the recap's file links. */
      files: z
        .object({
          environmentId: z.string(),
          root: z.string().nullable(),
          hostId: z.string().nullable(),
        })
        .nullable(),
    }),
  },
  /** Hides the current recap card on every client. */
  recap_dismiss: {
    input: z.object({ threadId: z.string().min(1), recapId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  /** Cancels the current waiting recap's scheduled status check. */
  recap_cancel_waiting: {
    input: z.object({ threadId: z.string().min(1), recapId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  /** Restores the current recap card on every client. */
  recap_restore: {
    input: z.object({ threadId: z.string().min(1), recapId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  /**
   * Sends one of the current recap's suggested next actions as the user's
   * message. `action` must be one the recap still offers.
   */
  recap_send: {
    input: z.object({
      threadId: z.string().min(1),
      recapId: z.string(),
      action: z.string().min(1),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  /** Workstreams' feature-grouped preferences (domain/prefs.ts). */
  prefs: {
    input: z.null(),
    output: z.object({ prefs: prefsSchema }),
  },
  /** Saves a patch and broadcasts the result as the `prefs` realtime event. */
  setPrefs: {
    input: z.object({ patch: prefsPatchSchema }),
    output: z.object({ prefs: prefsSchema }),
  },
  /** Connected machines, for the analysis-machine picker. */
  machines: {
    input: z.null(),
    output: z.object({
      machines: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  },
  recapPrefs: {
    input: z.null(),
    output: z.object({ prefs: recapPrefsSchema }),
  },
  setRecapPrefs: {
    input: z.object({ patch: recapPrefsSchema.partial() }),
    output: z.object({ prefs: recapPrefsSchema }),
  },
  state: {
    input: z.null(),
    output: z.object({
      workstreams: z.record(z.string(), recordSchema),
      placements: z.record(z.string(), placementSchema),
      analysis: z.record(z.string(), analysisSchema),
      /** Agent recaps for each thread's latest turn, dismissed ones included. */
      recaps: z.record(z.string(), recapSchema).default({}),
      /** Drift flags dismissed, by thread: the target that was dismissed. */
      driftDismissed: z.record(z.string(), z.string()),
      bootstrapped: z.boolean(),
      lastReconciledAt: z.number().nullable(),
      /** The sidebar's drag-and-drop order. */
      order: orderSchema,
      /** Snoozed threads, by id (see domain/snooze.ts). */
      snoozes: z.record(z.string(), snoozeSchema).default({}),
      /** What a click snoozes for, the hover menu's choices, and morning. */
      snoozePrefs: snoozePrefsSchema,
    }),
  },
  /**
   * Snoozes a thread until a time, or (`until: null`) until its next
   * activity. Snoozing again replaces the earlier snooze.
   */
  snooze: {
    input: z.object({
      threadId: z.string().min(1),
      until: z.number().int().positive().nullable(),
    }),
    output: z.object({ snooze: snoozeSchema }),
  },
  /** Saves the Snooze settings section's changes and tells every client. */
  setSnoozePrefs: {
    input: z.object({ patch: snoozePrefsPatchSchema }),
    output: z.object({ prefs: snoozePrefsSchema }),
  },
  /** Wakes a snoozed thread now. */
  unsnooze: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ woke: z.boolean() }),
  },
  /**
   * Stores the sidebar's arrangement: every workstream top to bottom, the
   * prioritized workstreams (a set), or one group's root threads (a section
   * id or "unsorted") top to bottom.
   */
  reorder: {
    input: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("workstreams"), ids: idList }),
      z.object({ kind: z.literal("prioritized"), ids: idList }),
      z.object({
        kind: z.literal("threads"),
        groupId: z.string().min(1),
        ids: idList,
      }),
    ]),
    output: z.object({ order: orderSchema }),
  },
  /** The working indicator's style, chosen in the plugin's settings section. */
  spinner: {
    input: z.null(),
    output: z.object({ spinner: spinnerSchema }),
  },
  /** Stores the working indicator's style and pushes it to every client. */
  setSpinner: {
    input: z.object({ spinner: spinnerSchema }),
    output: z.object({ spinner: spinnerSchema }),
  },
  editWorkstream: {
    input: z.object({
      sectionId: z.string().min(1),
      description: z.string().max(300).nullable().optional(),
      aliases: z.array(z.string().max(80)).max(20).optional(),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  /** The per-thread drift flag's actions (SPEC §9, §10). */
  drift: {
    input: z.object({
      threadId: z.string().min(1),
      action: z.enum(["handoff", "move", "dismiss"]),
    }),
    output: z.object({ threadId: z.string().nullable() }),
  },
  /** The recap whose Archive button may show: the thread has no outstanding work. */
  archiveStatus: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ recapId: z.string().nullable() }),
  },
  /** Archives the thread from its recap, rechecking outstanding work first. */
  archive: {
    input: z.object({ threadId: z.string().min(1), recapId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  bootstrap: {
    input: z.discriminatedUnion("action", [
      z.object({ action: z.literal("get") }),
      z.object({ action: z.literal("start") }),
      z.strictObject({
        action: z.literal("apply"),
        runId: z.number().int().nonnegative(),
        overrides: z
          .array(
            z.strictObject({
              threadId: z.string().min(1).max(200),
              accepted: z.boolean(),
            }),
          )
          .max(500)
          .refine(
            (items) =>
              new Set(items.map((i) => i.threadId)).size === items.length,
            "Duplicate thread overrides",
          ),
      }),
      z.object({ action: z.literal("cancel") }),
    ]),
    output: z.object({ state: bootstrapSchema, bootstrapped: z.boolean() }),
  },
  journal: {
    input: z
      .object({
        limit: z.number().int().min(1).max(500).optional(),
        before: z.number().optional(),
        external: z.boolean().optional(),
      })
      .nullable(),
    output: z.object({
      entries: z.array(
        // Debug traces of the model calls behind each entry (SPEC §11.6).
        entrySchema.extend({ traceIds: z.array(z.string()) }),
      ),
    }),
  },
  moveThread: {
    input: z.object({
      threadId: z.string().min(1),
      sectionId: z.string().min(1).nullable(),
    }),
    output: z.object({ entry: entrySchema.nullable() }),
  },
  createWorkstream: {
    input: z.object({
      name: z.string().min(1).max(200),
      /** The scope the router proposed with a new workstream. */
      description: z.string().max(500).optional(),
      threadId: z.string().min(1).optional(),
    }),
    output: z.object({ sectionId: z.string(), entry: entrySchema }),
  },
  renameWorkstream: {
    input: z.object({
      sectionId: z.string().min(1),
      name: z.string().min(1).max(200),
    }),
    output: z.object({ entry: entrySchema.nullable() }),
  },
  undo: {
    input: z.object({ entryId: z.string().min(1) }),
    output: z.object({ entry: entrySchema }),
  },
  refresh: { input: z.null(), output: z.object({ changed: z.boolean() }) },
  /**
   * Debug traces (SPEC §11.6), newest first: the given ids, the calls linked
   * to one thread, entry, proposal, workstream, or organizing run, or the
   * latest of every kind.
   */
  traces: {
    input: z.object({
      ids: z.array(z.string()).max(500).optional(),
      link: linkSchema.optional(),
      kind: z.enum(TRACE_KINDS).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      /** Page cursor: the last trace of the previous page. */
      before: z.object({ at: z.number(), id: z.string() }).optional(),
    }),
    output: z.object({ traces: z.array(traceSummarySchema) }),
  },
  /** One trace in full: prompt, reasoning, response, parsed result, links. */
  trace: {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ trace: traceSchema.nullable() }),
  },
  /** Sends a trace's prompt to its model again; changes nothing else. */
  traceReplay: {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ trace: traceSchema }),
  },
  traceClear: {
    input: z.null(),
    output: z.object({ removed: z.number() }),
  },
});

export type RpcContract = typeof rpcContract;
