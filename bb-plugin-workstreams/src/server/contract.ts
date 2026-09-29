import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { WORK_STATES } from "../domain/analysis.ts";
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
  })
  .nullable();

export const rpcContract = defineRpcContract({
  /** Plugin-side facts the live sidebar hook doesn't carry. */
  state: {
    input: z.null(),
    output: z.object({
      workstreams: z.record(z.string(), recordSchema),
      placements: z.record(z.string(), placementSchema),
      analysis: z.record(z.string(), analysisSchema),
      proposals: z.array(proposalSchema),
      bootstrapped: z.boolean(),
      lastReconciledAt: z.number().nullable(),
    }),
  },
  editWorkstream: {
    input: z.object({
      sectionId: z.string().min(1),
      description: z.string().max(300).nullable().optional(),
      aliases: z.array(z.string().max(80)).max(20).optional(),
    }),
    output: z.object({ ok: z.literal(true) }),
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
    output: z.object({ entries: z.array(entrySchema) }),
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
});

export type RpcContract = typeof rpcContract;
