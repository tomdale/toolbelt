import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { WORK_STATES } from "../domain/analysis.ts";
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

const proposalSchema = z.object({
  id: z.string(),
  kind: z.enum(["spin-out", "move", "merge"]),
  status: z.enum([
    "pending",
    "applying",
    "applied",
    "partial",
    "undone",
    "dismissed",
    "expired",
  ]),
  subject: z.string(),
  sourceSectionId: z.string().nullable(),
  sourceName: z.string(),
  targetSectionId: z.string().nullable(),
  targetName: z.string(),
  threadIds: z.array(z.string()),
  entryId: z.string().nullable(),
  acknowledged: z.boolean(),
  text: z.string(),
  accept: z.string(),
  updatedAt: z.number(),
  traceIds: z.array(z.string()),
});

const moveSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  from: z.string().nullable(),
  fromName: z.string(),
  to: z.string(),
  toName: z.string(),
  reason: z.string(),
  accepted: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  traceId: z.string().nullable().optional(),
});

const bootstrapSchema = z
  .object({
    status: z.enum([
      "proposing",
      "review",
      "assigning",
      "preview",
      "applying",
      "applied",
      "failed",
    ]),
    startedAt: z.number(),
    updatedAt: z.number(),
    error: z.string().nullable(),
    roots: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        sectionId: z.string().nullable(),
        provenance: z.enum(["user", "auto", "unfiled"]),
      }),
    ),
    descriptions: z.record(z.string(), z.string()),
    changes: z.array(
      z
        .object({
          id: z.string(),
          accepted: z.boolean(),
          kind: z.enum(["rename", "merge", "create"]),
        })
        .passthrough(),
    ),
    preview: z
      .object({
        creates: z.array(
          z.object({ name: z.string(), description: z.string().nullable() }),
        ),
        renames: z.array(
          z.object({ sectionId: z.string(), from: z.string(), to: z.string() }),
        ),
        moves: z.array(moveSchema),
        unsure: z.array(z.object({ threadId: z.string(), title: z.string() })),
      })
      .nullable(),
    entryId: z.string().nullable(),
    seconds: z.object({
      intake: z.number(),
      map: z.number(),
      assign: z.number(),
      apply: z.number(),
    }),
    traceIds: z.array(z.string()).default([]),
    mapTraceId: z.string().nullable().default(null),
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

const orderSchema = z.object({
  workstreams: z.array(z.string()),
  threads: z.record(z.string(), z.array(z.string())),
});

const routeBase = {
  id: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
  subject: z.string().nullable(),
  traceId: z.string().nullable(),
};
const placementSchema2 = z.object({
  projectId: z.string(),
  environment: z.record(z.string(), z.unknown()),
  label: z.string(),
});
export const routeSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...routeBase,
    outcome: z.literal("continue"),
    threadId: z.string(),
    threadTitle: z.string(),
    workstream: z.string().nullable(),
    sectionId: z.string().nullable(),
  }),
  z.object({
    ...routeBase,
    outcome: z.literal("new-thread"),
    sectionId: z.string(),
    workstream: z.string(),
    title: z.string(),
    placement: placementSchema2,
  }),
  z.object({
    ...routeBase,
    outcome: z.literal("new-workstream"),
    name: z.string(),
    description: z.string(),
    title: z.string(),
    placement: placementSchema2,
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
  /** Where new work would go (SPEC §6). Changes nothing. */
  route: {
    input: z.object({
      prompt: z.string().min(1).max(20_000),
      pickedProjectId: z.string().nullable().optional(),
      workstreamId: z.string().nullable().optional(),
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
      execution: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
    output: z.object({
      threadId: z.string().nullable(),
      sectionId: z.string().nullable(),
    }),
  },
  /** Plugin-side facts the live sidebar hook doesn't carry. */
  state: {
    input: z.null(),
    output: z.object({
      workstreams: z.record(z.string(), recordSchema),
      placements: z.record(z.string(), placementSchema),
      analysis: z.record(z.string(), analysisSchema),
      proposals: z.array(proposalSchema),
      /** Drift flags dismissed, by thread: the target that was dismissed. */
      driftDismissed: z.record(z.string(), z.string()),
      bootstrapped: z.boolean(),
      lastReconciledAt: z.number().nullable(),
      /** The sidebar's drag-and-drop order. */
      order: orderSchema,
    }),
  },
  /**
   * Stores the sidebar's manual order: every workstream, or one group's root
   * threads (a section id or "unsorted"), top to bottom.
   */
  reorder: {
    input: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("workstreams"), ids: idList }),
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
  proposal: {
    input: z.object({
      id: z.string().min(1),
      action: z.enum(["accept", "dismiss", "acknowledge"]),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  bootstrap: {
    input: z.discriminatedUnion("action", [
      z.object({ action: z.literal("get") }),
      z.object({ action: z.literal("start") }),
      z.object({
        action: z.literal("assign"),
        decisions: z.array(
          z.object({
            id: z.string(),
            accepted: z.boolean(),
            name: z.string().max(80).optional(),
          }),
        ),
      }),
      z.object({
        action: z.literal("apply"),
        overrides: z.array(
          z.object({ threadId: z.string(), accepted: z.boolean() }),
        ),
      }),
      z.object({ action: z.literal("skip") }),
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
