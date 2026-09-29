import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { entrySchema, sourceSchema } from "./journal.ts";

const placementSchema = z.object({
  sectionId: z.string().nullable(),
  source: sourceSchema,
  at: z.number(),
  entryId: z.string().nullable(),
});

const recordSchema = z.object({
  description: z.string().nullable(),
  descriptionSource: z.enum(["generated", "user"]),
  createdBy: z.enum(["user", "workstreams"]),
});

export const rpcContract = defineRpcContract({
  /** Plugin-side facts the live sidebar hook doesn't carry. */
  state: {
    input: z.null(),
    output: z.object({
      workstreams: z.record(z.string(), recordSchema),
      placements: z.record(z.string(), placementSchema),
      lastReconciledAt: z.number().nullable(),
    }),
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
  parentLink: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ id: z.string(), title: z.string() }).nullable(),
  },
});

export type RpcContract = typeof rpcContract;
