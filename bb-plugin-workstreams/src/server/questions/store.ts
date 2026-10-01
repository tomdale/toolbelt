import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Database } from "../db.ts";
import {
  interactionPayloadSchema,
  interactionResponseSchema,
  type InteractionPayload,
} from "./contracts.ts";
import { buildToolResult } from "./translate.ts";

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
        "INSERT INTO ws_question (id, thread_id, payload, status) VALUES (?, ?, ?, 'pending')",
      )
      .run(id, threadId, JSON.stringify(payload));
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

  interrupted(id: string) {
    this.live.delete(id);
  }

  finish(id: string) {
    this.live.delete(id);
    this.db
      .prepare("UPDATE ws_question SET status = 'resolved' WHERE id = ?")
      .run(id);
    this.bb.realtime.publish("changed", {});
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
      this.finish(id);
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
