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
  // What the thread is for, which is also its title. Older analysis rows
  // predate goals, and rows from when a thread also had an inferred title
  // carry a `title` that is not sent.
  goal: z.string().nullable().default(null),
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

const assignmentProvenanceSchema = z.enum(["manual", "automatic"]);
const assignmentStatusSchema = z.enum(["assigned", "unresolved"]);

const canonicalAssignmentSchema = z.object({
  threadId: z.string(),
  entityId: z.string().nullable(),
  status: assignmentStatusSchema,
  provenance: assignmentProvenanceSchema.nullable(),
  label: z.string().nullable(),
  ancestorIds: z.array(z.string()),
  evidence: z.string().nullable(),
  inheritedFrom: z.string().nullable(),
});

export const liveOrganizationGroupMemberSchema = z.object({
  id: z.string(),
  title: z.string(),
  completed: z.boolean(),
  identityId: z.string().nullable(),
  identityLabel: z.string().nullable(),
  provenance: assignmentProvenanceSchema.nullable(),
  reason: z.string(),
});

export const liveOrganizationGroupSchema = z.object({
  key: z.string(),
  sectionId: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  activeCount: z.number(),
  completedCount: z.number(),
  totalCount: z.number(),
  roots: z.array(liveOrganizationGroupMemberSchema),
});

export const liveOrganizationUnresolvedSchema = z.object({
  id: z.string(),
  title: z.string(),
  completed: z.boolean(),
  evidence: z.string().nullable(),
  reason: z.string(),
});

export const liveOrganizationCountsSchema = z.object({
  activeRoots: z.number(),
  completedRoots: z.number(),
  totalRoots: z.number(),
  unresolvedRoots: z.number(),
  activeWorkstreams: z.number(),
});

export const liveOrganizationSchema = z.object({
  status: z.enum(["idle", "classifying", "deriving", "syncing", "failed"]),
  progress: z
    .object({
      stage: z.enum(["classifying", "deriving", "syncing"]),
      completed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      cached: z.number().int().nonnegative(),
      unresolved: z.number().int().nonnegative(),
    })
    .nullable(),
  error: z.string().nullable(),
  lastUpdatedAt: z.number().nullable(),
  groups: z.array(liveOrganizationGroupSchema),
  unresolved: z.array(liveOrganizationUnresolvedSchema),
  counts: liveOrganizationCountsSchema,
});

export type LiveOrganization = z.infer<typeof liveOrganizationSchema>;
export type LiveOrganizationGroup = z.infer<typeof liveOrganizationGroupSchema>;
export type LiveOrganizationGroupMember = z.infer<
  typeof liveOrganizationGroupMemberSchema
>;
export type LiveOrganizationUnresolved = z.infer<
  typeof liveOrganizationUnresolvedSchema
>;
export type LiveOrganizationCounts = z.infer<typeof liveOrganizationCountsSchema>;

const draftAncestorSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
});

export const draftSubjectProposalSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  parentId: z.string().nullable().optional(),
  ancestors: z.array(draftAncestorSchema).nullable().optional(),
});

export const taskIdentitySubmissionSchema = z.object({
  entityId: z.string().min(1).nullable().optional(),
  proposal: draftSubjectProposalSchema.nullable().optional(),
  provenance: assignmentProvenanceSchema.optional(),
});


const entitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  parentId: z.string().nullable(),
  aliases: z.array(z.string()),
});

const catalogStateSchema = z.object({
  entities: z.array(entitySchema),
  groups: z.record(z.string(), z.string()),
  assignments: z.record(z.string(), canonicalAssignmentSchema),
  revision: z.number(),
});

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
  subjectId: z.string().nullable().optional(),
  proposal: draftSubjectProposalSchema.nullable().optional(),
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
   * Starts New work's thread with the composer's resolved request and
   * product/feature identity; section navigation is derived automatically.
   */
  startThread: {
    input: z.object({
      identity: taskIdentitySubmissionSchema.nullable().optional(),
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
   * The Product or feature the New thread banner shows for a draft, reported
   * as the draft changes so the dispatch hook can file the thread a plain
   * Enter creates (`ComposedDrafts`). Empty text forgets the draft.
   */
  draftIdentity: {
    input: z.object({
      draftKey: z.string().min(1).max(500),
      text: z.string().max(20_000),
      identity: taskIdentitySubmissionSchema.nullable(),
    }),
    output: z.object({ filed: z.boolean() }),
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
  /**
   * Hides the current recap card on every client. Dismissing a waiting card
   * also cancels its status check.
   */
  recap_dismiss: {
    input: z.object({ threadId: z.string().min(1), recapId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  /**
   * Live state of the agent threads a waiting recap names. Agent threads are
   * usually hidden, so the sidebar's thread list does not carry them.
   * Unreadable threads are left out.
   */
  recap_agents: {
    input: z.object({
      threadIds: z.array(z.string().min(1)).max(20),
    }),
    output: z.object({
      agents: z.array(
        z.object({
          threadId: z.string(),
          projectId: z.string(),
          title: z.string(),
          status: z.string(),
          runtimeStatus: z.string(),
          hasPendingInteraction: z.boolean(),
          isArchived: z.boolean(),
        }),
      ),
    }),
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
  catalog: {
    input: z.null(),
    output: catalogStateSchema,
  },
  catalogReset: {
    input: z.object({ confirm: z.literal(true) }),
    output: z.object({ ok: z.literal(true) }),
  },
  catalogResolve: {
    input: z.object({ entityId: z.string().min(1) }),
    output: z.object({
      sectionId: z.string().nullable(),
      name: z.string().nullable(),
    }),
  },
  catalogCreate: {
    input: z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(1000).default(""),
      parentId: z.string().min(1).nullable().optional(),
      aliases: z.array(z.string().max(80)).default([]),
    }),
    output: z.object({ entity: entitySchema }),
  },
  catalogRename: {
    input: z.object({
      entityId: z.string().min(1),
      name: z.string().min(1).max(200),
    }),
    output: z.object({ entity: entitySchema }),
  },
  catalogReparent: {
    input: z.object({
      entityId: z.string().min(1),
      parentId: z.string().min(1).nullable(),
    }),
    output: z.object({ entity: entitySchema }),
  },
  catalogUpdateMetadata: {
    input: z.object({
      entityId: z.string().min(1),
      description: z.string().max(1000).optional(),
      aliases: z.array(z.string().max(80)).optional(),
    }),
    output: z.object({ entity: entitySchema }),
  },
  catalogMerge: {
    input: z.object({
      sourceEntityId: z.string().min(1),
      targetEntityId: z.string().min(1),
    }),
    output: z.object({
      target: entitySchema,
      affectedThreads: z.number(),
      reparentedChildren: z.number(),
    }),
  },
  taskAssign: {
    input: z.object({
      threadId: z.string().min(1),
      entityId: z.string().min(1),
    }),
    output: z.object({ assignment: canonicalAssignmentSchema }),
  },
  taskClear: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ assignment: canonicalAssignmentSchema }),
  },
  taskReclassify: {
    input: z.object({
      threadId: z.string().min(1),
      entityId: z.string().min(1).optional(),
      evidence: z.string().optional(),
    }),
    output: z.object({ assignment: canonicalAssignmentSchema }),
  },
  taskAssignment: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ assignment: canonicalAssignmentSchema }),
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
      catalog: catalogStateSchema.default({
        entities: [],
        groups: {},
        assignments: {},
        revision: 1,
      }),
      organization: liveOrganizationSchema.default({
        status: "idle",
        progress: null,
        error: null,
        lastUpdatedAt: null,
        groups: [],
        unresolved: [],
        counts: {
          activeRoots: 0,
          completedRoots: 0,
          totalRoots: 0,
          unresolvedRoots: 0,
          activeWorkstreams: 0,
        },
      }),
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
  organization: {
    input: z
      .object({
        action: z.enum(["get", "rebuild"]).optional(),
      })
      .nullable()
      .default(null),
    output: z.object({ state: liveOrganizationSchema }),
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
  /** Files a Debug-mode classifier report in the Workstreams workstream. */
  flagRoute: {
    input: z.object({
      diagnostics: z.string().min(1).max(1_000_000),
      projectId: z.string().min(1).nullable().optional(),
    }),
    output: z.object({ threadId: z.string(), sectionId: z.string() }),
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
