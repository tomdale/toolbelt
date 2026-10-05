import type { Entity } from "../src/domain/classify.ts";

/** One classification case's evidence, as Full analysis is shown it. */
export type ClassifyInput = {
  /** The thread's title and summary, standing in for its latest reply. */
  prompt: string;
  entities: Entity[];
  project?: string | null;
  requests?: string[];
};
export const entities = [
  {
    id: "platform",
    name: "Harbor",
    description: "Application platform",
    parentId: null,
    aliases: [],
  },
  {
    id: "shared",
    name: "Automations",
    description: "Shared automation-run infrastructure consumed by tools",
    parentId: "platform",
    aliases: [],
  },
  {
    id: "agent",
    name: "Beacon",
    description: "Investigation assistant product",
    parentId: null,
    aliases: [],
  },
  {
    id: "jobs",
    name: "Automations",
    description: "Scheduled assistant actions",
    parentId: "agent",
    aliases: [],
  },
  {
    id: "investigate",
    name: "Investigations",
    description: "Manual and automated investigation of alerts",
    parentId: "agent",
    aliases: [],
  },
  {
    id: "work",
    name: "Loom",
    description: "Agent work organization plugin",
    parentId: null,
    aliases: [],
  },
  {
    id: "recap",
    name: "Recaps",
    description: "Task summaries",
    parentId: "work",
    aliases: [],
  },
  {
    id: "waiting",
    name: "Waiting",
    description: "Summary countdowns and async checks",
    parentId: "recap",
    aliases: [],
  },
  {
    id: "questions",
    name: "Questions",
    description: "Interactive questions and answers",
    parentId: "work",
    aliases: [],
  },
  {
    id: "providers",
    name: "Providers",
    description: "Agent provider selection and routing",
    parentId: "platform",
    aliases: [],
  },
  {
    id: "sdk",
    name: "SDK",
    description: "Plugin interfaces",
    parentId: "platform",
    aliases: [],
  },
  {
    id: "blocks",
    name: "Message blocks",
    description: "Shared rich output contracts",
    parentId: "sdk",
    aliases: [],
  },
  {
    id: "todo",
    name: "Checklist",
    description: "Todo plugin",
    parentId: null,
    aliases: [],
  },
  {
    id: "gutter",
    name: "Gutter mode",
    description: "Floating todo presentation beside the conversation",
    parentId: "todo",
    aliases: [],
  },
  {
    id: "tool",
    name: "Prism CLI",
    description: "Code review execution tool",
    parentId: null,
    aliases: [],
  },
];
export const cases: {
  id: string;
  input: ClassifyInput;
  expected: string | null;
}[] = [
  [
    "review-tool",
    "Review via Prism CLI",
    "Review Beacon scheduled actions using Prism CLI; the change fixes action scheduling.",
    "jobs",
  ],
  [
    "repository-owner",
    "Backend API changes",
    "In the harbor/api repository, implement Beacon automation scheduling.",
    "jobs",
  ],
  [
    "cron-mechanism",
    "Cron failures",
    "Diagnosed failed Beacon scheduled actions: the cron trigger stops invoking them. Fix the trigger.",
    "jobs",
  ],
  [
    "sibling-capability",
    "Automation investigation",
    "Fix manual alert investigation in Beacon. Automations can trigger investigations too, but this is the investigation capability.",
    "investigate",
  ],
  [
    "misleading-title",
    "Fix recap renderer",
    "Delivered question answers in Loom should render as a Q&A card, not raw tool JSON.",
    "questions",
  ],
  [
    "waiting-schema",
    "Schema compatibility",
    "Fix Loom waiting recap schema for countdowns and async status checks.",
    "waiting",
  ],
  [
    "symptom-owner",
    "Worker plugin failures",
    "Errors appear in worker plugins. Diagnosis: Harbor core provider routing sends the wrong provider ID; fix core routing.",
    "providers",
  ],
  [
    "followup-build",
    "New Personal build",
    "Finish the issue submission and build for the diagnosed Harbor provider-ID routing defect.",
    "providers",
  ],
  [
    "component-mode",
    "Contextual Checklist UI",
    "Fix Checklist's floating gutter display; keep composer-attached display unchanged.",
    "gutter",
  ],
  [
    "shared-primary",
    "Loom output design",
    "Primary deliverable: Harbor SDK message-block contract. Update Loom as the first consumer.",
    "blocks",
  ],
  [
    "shared-consumer",
    "Beacon automation artifacts",
    "Review Harbor's general automation-run artifacts. Beacon is one consumer; the shared platform contract is the deliverable.",
    "shared",
  ],
  [
    "tool-itself",
    "Prism CLI",
    "Fix Prism CLI's review command argument parsing.",
    "tool",
  ],
  [
    "holdout-question",
    "Summary pipeline bug",
    "The Loom question-and-answer card is the deliverable. Fix answers rendering as plain text; recap summaries are unaffected.",
    "questions",
  ],
  [
    "holdout-sdk",
    "Beacon rendering",
    "Implement Harbor's SDK Message blocks contract; Beacon consumes it but the reusable SDK interface is the primary change.",
    "blocks",
  ],
  [
    "holdout-waiting",
    "Timer schema",
    "Loom Recaps has a Waiting feature. Update its async countdown schema, not another product's timers.",
    "waiting",
  ],
  [
    "ambiguous",
    "Review 482",
    "Review change 482 using Prism. No product or change scope is available.",
    null,
  ],
].map(([id, title, request, expected]) => ({
  id: id!,
  expected: expected ?? null,
  input: {
    prompt: title!,
    project: "Coordination",
    requests: [request!],
    entities,
  },
}));
