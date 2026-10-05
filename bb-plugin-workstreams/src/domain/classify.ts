/**
 * Classification: choosing the most specific topic a thread is about, or
 * proposing a new one. Quick analysis and Full analysis both ask for a topic
 * with these rules and parse the answer with `parseTopic`, so a thread is
 * classified the same way whether from its first request or a finished turn.
 */
import { z } from "zod";
import { redact } from "./redact.ts";
import { resolveProposal, type DraftSubjectProposal } from "./topics.ts";

export const entitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  parentId: z.string().nullable(),
  aliases: z.array(z.string()),
});
export type Entity = Omit<z.infer<typeof entitySchema>, "aliases"> & {
  aliases: readonly string[];
};

/** The largest topic tree a prompt may carry. */
export const TOPIC_TREE_MAX = 500;

const proposalSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z
      .string()
      .trim()
      .max(300)
      .nullish()
      .transform((d) => d ?? ""),
    parentId: z.string().nullish(),
    ancestors: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(80),
          description: z
            .string()
            .trim()
            .max(300)
            .nullish()
            .transform((d) => d ?? ""),
        }),
      )
      .max(5)
      .nullish(),
  })
  // The model omits an unused proposal instead of returning null, so an
  // absent `proposed` must parse as no proposal.
  .nullish();

/** The topic fields of a model answer, before they are checked. */
export const topicFieldsSchema = z.object({
  subjectId: z.string().nullish(),
  proposed: proposalSchema,
});

/** A checked topic answer: an existing topic, a new one, or neither. */
export type TopicAnswer = {
  subjectId: string | null;
  proposed: DraftSubjectProposal | null;
};

const text = (value: string, max: number) =>
  redact(value).replace(/\s+/g, " ").trim().slice(0, max);

/** The topic tree as indented lines; bracketed IDs identify topics. */
export function topicTreeBlock(entities: readonly Entity[]): string {
  if (entities.length > TOPIC_TREE_MAX)
    throw new Error("The topic tree is too large for one prompt.");
  const rows: string[] = [];
  const visited = new Set<string>();
  const visit = (entity: Entity, depth: number) => {
    if (visited.has(entity.id)) throw new Error("Invalid topic ancestry.");
    visited.add(entity.id);
    const description = text(entity.description ?? "", 300);
    const aliases = entity.aliases
      .map((alias) => text(alias, 80))
      .filter(Boolean);
    rows.push(
      `${"  ".repeat(depth)}- ${text(entity.name, 80)} [${entity.id}]${description ? ` — ${description}` : ""}${aliases.length ? `; aliases: ${aliases.join(", ")}` : ""}`,
    );
    for (const child of entities.filter((e) => e.parentId === entity.id))
      visit(child, depth + 1);
  };
  for (const root of entities.filter((e) => e.parentId === null))
    visit(root, 0);
  if (visited.size !== entities.length)
    throw new Error("Invalid topic ancestry.");
  return rows.length ? rows.join("\n") : "(no topics yet)";
}

/**
 * How to choose a topic. Shared verbatim by every prompt that classifies, so
 * the classification eval measures the rules production uses.
 */
export const CLASSIFICATION_RULES = `Ownership: User requests and explicit diagnoses establish the object being built, changed, reviewed, or studied, and outrank titles, summaries, project hints, and familiar topic names. Privately identify the primary deliverable, owner, capability, and supported subcapability. A follow-up build, review, or issue submission retains the diagnosed owner unless requests shift scope. A symptom's location is not proof of defect ownership. Project names locate work but do not establish its user-facing owner. Repository, backend, scheduler, hosting platform, agent provider, shell, and execution-tool names locate work; they own it only when the requested change concerns them. Review work belongs to the reviewed capability. Shared platform capabilities and contracts belong to the platform; consuming products retain their own features. For cross-product work choose the primary deliverable; return no topic when no primary owner is supported. A URL or opaque reference without scope evidence supports at most a known product, not an inferred feature. Use supplied scope, not assumed real-world product associations; descriptions contain only supported facts.

Matching: Compare local names, aliases, descriptions, and full ancestry. Prefer an existing topic whose documented scope covers the requested change, including topics no thread has now. Do not propose a narrower child merely to restate that scope: a topic describing provider routing already covers a routing fix; a topic describing automation-run infrastructure covers its artifacts. Choose the topic independently of how threads are grouped. Do not decide placement, continuation, or execution settings.

Discovery: Use the established owner's recognizable name as root. A separately named tool product stays intact; a product's SDK is a capability under that product. Topics below a product are user-facing capabilities, not implementation layers or lifecycle buckets. Components, integrations, and display modes belong to a supported owner rather than becoming roots. Subcapabilities belong under their supported immediate parent. Add intermediate topics only when evidence supports distinct capabilities. Preserve explicit intermediate capabilities: a waiting recap can be product → Recaps → Waiting; an SDK message-block contract can be product → SDK → Message blocks. These illustrate structure, not prescribed product names. Triggering or consuming another capability, or targeting an object, does not establish parentage. Manual and automated operation are modes, not separate topics. When specificity is unclear, choose a supported ancestor.

Represent a proposal using local names without colons or product prefixes. parentId references the deepest existing ancestor, or null when none applies. ancestors lists missing parents from outermost to immediate parent; name is the leaf. Limit missing ancestors to five; choose a nearer supported ancestor if more are needed. Leave unsupported parentage null. Give an existing topic OR a proposal, never both; vague ownership gives both null.
Existing topic: "subjectId":"existing id","proposed":null
New topic: "subjectId":null,"proposed":{"name":"local name","description":"supported scope","parentId":null,"ancestors":[{"name":"missing parent local name","description":"scope"}]}
No topic: "subjectId":null,"proposed":null`;

/**
 * Checks a topic answer against the tree it was asked about and anchors a
 * proposal at its deepest existing ancestor; a proposal naming an existing
 * topic becomes that topic.
 */
export function parseTopic(
  fields: z.infer<typeof topicFieldsSchema>,
  entities: readonly Entity[],
): TopicAnswer {
  const ids = new Set(entities.map((e) => e.id));
  const subjectId = fields.subjectId ?? null;
  const proposed = fields.proposed ?? null;
  if (
    (subjectId && !ids.has(subjectId)) ||
    (proposed?.parentId && !ids.has(proposed.parentId)) ||
    (subjectId && proposed) ||
    proposed?.name.includes(":") ||
    proposed?.ancestors?.some((a) => a.name.includes(":"))
  )
    throw new Error("The model named an unsupported topic.");
  if (!proposed) return { subjectId, proposed: null };
  const resolved = resolveProposal(proposed, entities);
  return resolved.subjectId !== null
    ? { subjectId: resolved.subjectId, proposed: null }
    : { subjectId: null, proposed: resolved.proposed };
}
