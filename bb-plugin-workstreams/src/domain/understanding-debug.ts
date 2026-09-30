import { z } from "zod";

/** Browser-safe contracts for inspecting memory; model output is parsed elsewhere. */
export const evidenceSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  entryId: z.string(),
  speaker: z.enum(["user", "assistant"]),
  quote: z.string(),
  observation: z.string(),
  epistemic: z.enum(["explicit", "intention", "reported_outcome", "inference"]),
  terms: z.array(z.string()),
  sourceAt: z.number().nullable(),
  traceId: z.string().nullable().default(null),
});
export const beliefSchema = z.object({
  id: z.string(),
  name: z.string(),
  narrative: z.string(),
  questions: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  updatedAt: z.number(),
  traceId: z.string().nullable().default(null),
});
export const progressSchema = z.object({
  threadId: z.string(),
  cursor: z.string().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  updatedAt: z.number(),
  dirty: z.number(),
  completedRevision: z.number().nullable(),
  backlog: z.number(),
});
export const revisionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  at: z.number(),
  action: z.enum(["created", "revised", "retired"]),
  before: beliefSchema.nullable(),
  after: beliefSchema.nullable(),
  traceId: z.string().nullable(),
  reason: z.string(),
});
export const retrievalCandidateSchema = z.object({
  kind: z.enum(["account", "observation"]),
  id: z.string(),
  title: z.string(),
  score: z.number(),
  matchedTerms: z.array(z.string()),
  disposition: z.enum([
    "included",
    "budget",
    "limit",
    "missing-evidence",
    "covered",
  ]),
  chars: z.number(),
});
export const retrievalReportSchema = z.object({
  query: z.string(),
  terms: z.array(z.string()),
  budget: z.number(),
  usedChars: z.number(),
  context: z.string(),
  accountIds: z.array(z.string()),
  observationIds: z.array(z.string()),
  candidates: z.array(retrievalCandidateSchema),
});
export const retrievalSnapshotSchema = z.object({
  id: z.string(),
  at: z.number(),
  consumer: z.enum(["analysis", "route"]),
  threadId: z.string().nullable(),
  traceId: z.string().nullable(),
  report: retrievalReportSchema,
});
export const debugOverviewSchema = z.object({
  accounts: z.array(beliefSchema),
  observations: z.array(evidenceSchema),
  progress: z.array(progressSchema),
  counts: z.object({
    accounts: z.number(),
    observations: z.number(),
    threads: z.number(),
    failed: z.number(),
    pending: z.number(),
  }),
  hasMoreAccounts: z.boolean(),
  hasMoreObservations: z.boolean(),
  hasMoreProgress: z.boolean(),
});
export const accountDetailSchema = z.object({
  account: beliefSchema.nullable(),
  evidence: z.array(evidenceSchema),
  revisions: z.array(revisionSchema),
  hasMoreRevisions: z.boolean(),
});
export const observationDetailSchema = z.object({
  observation: evidenceSchema.nullable(),
  accounts: z.array(beliefSchema),
  retrievals: z.array(retrievalSnapshotSchema),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export type Belief = z.infer<typeof beliefSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type RetrievalReport = z.infer<typeof retrievalReportSchema>;
export type RetrievalSnapshot = z.infer<typeof retrievalSnapshotSchema>;
export type DebugOverview = z.infer<typeof debugOverviewSchema>;
export type AccountDetail = z.infer<typeof accountDetailSchema>;
export type ObservationDetail = z.infer<typeof observationDetailSchema>;
