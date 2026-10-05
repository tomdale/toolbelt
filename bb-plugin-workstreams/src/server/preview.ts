/**
 * The New thread composer's preview of a draft (SPEC §6): the topic and goal
 * a new thread would start with, from Quick analysis, or the topic of a
 * workstream the draft mentions. It changes nothing, and it never sends the
 * draft anywhere: the composer creates the thread, and the topic decides its
 * workstream.
 */
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ModelChoice } from "../domain/prefs.ts";
import type { DraftSubjectProposal } from "../domain/topics.ts";
import { topicPath } from "../domain/topic-path.ts";
import type { TopicStore } from "./topics.ts";
import type { Inference } from "./model.ts";
import { UserError } from "./service.ts";

type Sdk = BbPluginApi["sdk"];

/** What a new thread from the draft would start with. */
export type Preview = {
  id: string;
  confidence: "high" | "medium" | "low";
  reason: string;
  /** The topic's label, for display. */
  subject: string | null;
  subjectId?: string | null;
  proposal?: DraftSubjectProposal | null;
  /** Quick analysis's goal for the thread: its provisional title. */
  goal?: string | null;
  /** The debug trace of the model call behind it (SPEC §11.6), if any. */
  traceId: string | null;
  /**
   * How the preview was reached, step by step, and how long it took.
   * Present only in Debug mode.
   */
  explanation?: { notes: string[]; durationMs: number };
};

export class ComposerPreview {
  constructor(
    private readonly deps: {
      sdk: () => Sdk;
      topics: TopicStore;
      inference: Inference;
      /** The Quick analysis model. */
      model: () => Promise<ModelChoice>;
    },
  ) {}

  /**
   * The draft's preview: the topic of a workstream it mentions, or Quick
   * analysis's goal and topic.
   */
  async preview(
    prompt: string,
    options: {
      pickedProjectId?: string | null;
      explain?: (note: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<Preview> {
    const text = prompt.trim();
    if (!text) throw new UserError("Describe the work first.");
    const explain = options.explain ?? (() => {});
    const mentioned = this.mentionedWorkstream(text, explain);
    if (mentioned) return mentioned;
    const projects = await this.deps.sdk().projects.list();
    const project = options.pickedProjectId
      ? (projects.find((p) => p.id === options.pickedProjectId)?.name ?? null)
      : null;
    const entities = this.deps.topics.list();
    const { value, traceId } = await this.deps.inference.run(
      "quick-analysis",
      { request: text, project, entities },
      {
        model: await this.deps.model(),
        signal: options.signal,
        label: text.replace(/\s+/g, " "),
      },
    );
    const label = value.subjectId
      ? topicPath(value.subjectId, entities)
      : (value.proposed?.name ?? null);
    explain(
      label
        ? `Quick analysis chose the topic "${label}".`
        : "Quick analysis found no clear topic.",
    );
    return {
      id: randomUUID(),
      confidence: label ? "high" : "low",
      reason: label
        ? "Chosen from the draft by Quick analysis."
        : "The draft doesn't say clearly enough what it's about.",
      subject: label,
      subjectId: value.subjectId,
      proposal: value.proposed,
      goal: value.goal,
      traceId,
    };
  }

  /** The topic of a workstream the draft mentions with `@section:<id>`. */
  private mentionedWorkstream(
    text: string,
    explain: (note: string) => void,
  ): Preview | null {
    const sectionId = /@section:([A-Za-z0-9_-]+)/.exec(text)?.[1];
    const topicId = sectionId
      ? this.deps.topics.groups().get(sectionId)
      : undefined;
    if (!topicId) return null;
    const label = topicPath(topicId, this.deps.topics.list());
    explain(
      `The draft mentions the workstream for "${label}", so no model was asked.`,
    );
    return {
      id: randomUUID(),
      confidence: "high",
      reason: "The draft mentions this workstream.",
      subject: label,
      subjectId: topicId,
      traceId: null,
    };
  }
}
