import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Database } from "../db.ts";
import {
  interactionPayloadSchema,
  interactionResponseSchema,
  type InteractionPayload,
  type ToolResult,
  toolInputSchema,
} from "./contracts.ts";
import { buildToolResult, buildInteractionPayload } from "./translate.ts";
import {
  deliveredQuestionResult,
  questionResultSchema,
  type QuestionHistory,
} from "./history.ts";

export class QuestionStore {
  private live = new Set<string>();
  constructor(
    private db: Database,
    private bb: BbPluginApi,
  ) {
    // A process can vanish between send and acknowledgement. Keep the question
    // available for explicit retry rather than silently losing the decision.
    const reset = db
      .prepare(
        "UPDATE ws_question SET status = 'pending' WHERE status = 'sending'",
      )
      .run();
    if (reset.changes)
      bb.log.warn(
        "Recovered an unacknowledged question answer; retry may duplicate a delivered message",
      );
  }

  open(threadId: string, payload: InteractionPayload) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO ws_question (id, thread_id, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      )
      .run(id, threadId, JSON.stringify(payload), Date.now());
    this.live.add(id);
    this.bb.realtime.publish("changed", {});
    return id;
  }

  pending(threadId: string) {
    const row = this.db
      .prepare(
        "SELECT id, payload FROM ws_question WHERE thread_id = ? AND status IN ('pending', 'sending') ORDER BY rowid DESC LIMIT 1",
      )
      .get(threadId) as { id: string; payload: string } | undefined;
    return row
      ? {
          id: row.id,
          recoverable: !this.live.has(row.id),
          payload: interactionPayloadSchema.parse(JSON.parse(row.payload)),
        }
      : null;
  }

  attach(threadId: string, interactionId: string) {
    this.db
      .prepare(
        "UPDATE ws_question SET interaction_id = ? WHERE thread_id = ? AND status = 'pending'",
      )
      .run(interactionId, threadId);
  }

  async atInteraction(
    threadId: string,
    interactionId: string,
  ): Promise<QuestionHistory | null> {
    const row = this.db
      .prepare(
        "SELECT id, payload, result, created_at, outcome, status FROM ws_question WHERE thread_id = ? AND interaction_id = ?",
      )
      .get(threadId, interactionId) as
      | {
          id: string;
          payload: string;
          result: string | null;
          created_at: number | null;
          outcome: QuestionHistory["status"] | null;
          status: string;
        }
      | undefined;
    if (row)
      return {
        id: row.id,
        at: row.created_at,
        status:
          row.status === "pending" || row.status === "sending"
            ? "pending"
            : (row.outcome ?? "unknown"),
        payload: interactionPayloadSchema.parse(JSON.parse(row.payload)),
        result: row.result
          ? questionResultSchema.parse(JSON.parse(row.result))
          : null,
      };
    // Old forms lack a durable association. Bound a scan around the exact
    // interaction, then pair the first delivered answer after that form.
    const events = await this.bb.sdk.threads.events.list({
      threadId,
      types: ["system/interaction/lifecycle", "client/turn/requested"],
      order: "desc",
      limit: "100",
    });
    const opened = events
      .filter(
        (e) =>
          e.type === "system/interaction/lifecycle" &&
          e.data.interaction.id === interactionId,
      )
      .sort((a, b) => a.seq - b.seq)[0];
    if (!opened) return null;
    const next = events
      .filter(
        (e) =>
          e.type === "system/interaction/lifecycle" &&
          e.data.interaction.origin?.kind === "plugin" &&
          e.data.interaction.origin.rendererId === "ask-user-question" &&
          e.data.interaction.id !== interactionId &&
          e.seq > opened.seq,
      )
      .sort((a, b) => a.seq - b.seq)[0];
    for (const event of events
      .filter((e) => e.seq > opened.seq && (!next || e.seq < next.seq))
      .sort((a, b) => a.seq - b.seq)) {
      if (event.type !== "client/turn/requested") continue;
      for (const part of event.data.input ?? []) {
        const result =
          part.type === "text" ? deliveredQuestionResult(part.text) : null;
        if (!result) continue;
        const input = toolInputSchema.safeParse({
          questions: result.questions,
        });
        if (!input.success) continue;
        return {
          id: interactionId,
          at: opened.createdAt,
          status: "answered",
          payload: buildInteractionPayload(input.data),
          result,
        };
      }
    }
    return null;
  }

  interrupted(id: string) {
    this.live.delete(id);
  }

  finish(
    id: string,
    result?: ToolResult | null,
    outcome: "answered" | "dismissed" | "unknown" = "unknown",
  ) {
    this.live.delete(id);
    this.db
      .prepare(
        "UPDATE ws_question SET status = 'resolved', result = ?, outcome = ? WHERE id = ?",
      )
      .run(result ? JSON.stringify(result) : null, outcome, id);
    this.bb.realtime.publish("changed", {});
  }

  async history(threadId: string): Promise<QuestionHistory[]> {
    // Import retained answers on demand, including those delivered before
    // Workstreams saved them. Bound each request and never inspect raw provider logs.
    const first = await this.bb.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested", "item/completed"],
      order: "desc",
      limit: "100",
    });
    const last = first.at(-1);
    const older =
      first.length === 100 && last
        ? await this.bb.sdk.threads.events.list({
            threadId,
            types: ["client/turn/requested", "item/completed"],
            order: "desc",
            limit: "100",
            beforeSeq: String(last.seq),
          })
        : [];
    const events = [...first, ...older];
    for (const event of events) {
      let result = null;
      if (event.type === "client/turn/requested") {
        for (const part of event.data.input ?? []) {
          if (part.type === "text")
            result = deliveredQuestionResult(part.text) ?? result;
        }
      } else if (
        event.type === "item/completed" &&
        event.data.item.type === "toolCall" &&
        event.data.item.tool === "AskUserQuestion" &&
        typeof event.data.item.result === "string"
      ) {
        try {
          const parsed = questionResultSchema.safeParse(
            JSON.parse(event.data.item.result),
          );
          if (parsed.success) result = parsed.data;
        } catch {
          /* Non-answer tool results are not history. */
        }
      }
      if (!result) continue;
      const parsed = toolInputSchema.safeParse({ questions: result.questions });
      if (!parsed.success) continue;
      const payload = buildInteractionPayload(parsed.data);
      // A saved answer and its retained delivery refer to the same decision.
      const existing = this.db
        .prepare("SELECT 1 FROM ws_question WHERE thread_id = ? AND result = ?")
        .get(threadId, JSON.stringify(result));
      if (!existing)
        this.db
          .prepare(
            "INSERT OR IGNORE INTO ws_question (id, thread_id, payload, status, result, created_at, outcome) VALUES (?, ?, ?, 'resolved', ?, ?, 'answered')",
          )
          .run(
            `history:${event.id}`,
            threadId,
            JSON.stringify(payload),
            JSON.stringify(result),
            event.createdAt,
          );
    }
    const rows = this.db
      .prepare(
        "SELECT id, payload, result, created_at, outcome, status FROM ws_question WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100",
      )
      .all(threadId) as {
      id: string;
      payload: string;
      result: string | null;
      created_at: number | null;
      outcome: QuestionHistory["status"] | null;
      status: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      at: row.created_at,
      status:
        row.status === "pending" || row.status === "sending"
          ? "pending"
          : (row.outcome ?? "unknown"),
      payload: interactionPayloadSchema.parse(JSON.parse(row.payload)),
      result: row.result
        ? questionResultSchema.parse(JSON.parse(row.result))
        : null,
    }));
  }

  async recover(
    threadId: string,
    id: string,
    value: unknown,
    dismiss: boolean,
  ) {
    const pending = this.pending(threadId);
    if (!pending || pending.id !== id)
      throw new Error("This question is no longer pending");
    if (!pending.recoverable)
      throw new Error("Answer the active question card instead");
    const result = dismiss
      ? null
      : buildToolResult(
          pending.payload,
          interactionResponseSchema.parse(value),
        );
    if (result && Object.keys(result.answers).length === 0)
      throw new Error("Please answer at least one question");
    // Claim before sending: simultaneous tabs must not dispatch the same answer.
    const claim = this.db
      .prepare(
        "UPDATE ws_question SET status = 'sending' WHERE id = ? AND status = 'pending'",
      )
      .run(id);
    if (!claim.changes) throw new Error("This answer is already being sent");
    try {
      await this.bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            text: dismiss
              ? `I dismissed the recovered question: ${pending.payload.questions.map((q) => q.prompt).join("; ")}. This is not an answer or approval. Keep dependent work blocked.`
              : `My answer to your question (recovered after the question tool was interrupted):\n${JSON.stringify(result)}\nUse this as my answer and resume the work that depended on it.`,
            mentions: [],
          },
        ],
      });
      this.finish(id, result, dismiss ? "dismissed" : "answered");
    } catch (error) {
      this.db
        .prepare(
          "UPDATE ws_question SET status = 'pending' WHERE id = ? AND status = 'sending'",
        )
        .run(id);
      throw error;
    }
  }
}
