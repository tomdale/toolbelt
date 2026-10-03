import { z } from "zod";

export type OrganizeInput = {
  workstreams: {
    id: string;
    name: string;
    description: string | null;
    aliases: string[];
  }[];
  threads: {
    id: string;
    title: string;
    recap: string | null;
    subject?: string | null;
    project: string | null;
    sectionId: string | null;
    children: string[];
  }[];
};

export const organizeProposalSchema = z.object({
  workstreams: z
    .array(
      z.object({
        key: z.string().min(1).max(100),
        sectionId: z.string().nullable(),
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().min(1).max(300),
        aliases: z.array(z.string().trim().min(1).max(80)).max(10),
      }),
    )
    .max(100),
  assignments: z
    .array(
      z.object({
        threadId: z.string(),
        workstream: z.string().nullable(),
        reason: z.string().max(200).default(""),
      }),
    )
    .max(500),
});
export type OrganizeProposal = z.infer<typeof organizeProposalSchema>;
