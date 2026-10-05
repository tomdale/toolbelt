import { useCallback, useEffect, useState } from "react";
import {
  Markdown,
  useRealtime,
  useRpc,
  type PluginTimelineRendererProps,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { QuestionHistory } from "../../server/questions/history.ts";
import { questionResultSchema } from "../../server/questions/history.ts";
import { buildInteractionPayload } from "../../server/questions/translate.ts";
import { toolInputSchema } from "../../server/questions/contracts.ts";

export function QuestionHistoryCard({ record }: { record: QuestionHistory }) {
  return (
    <div
      data-ws-question-history=""
      className="my-2 rounded-lg border border-amber-400/50 bg-background p-3 text-foreground"
    >
      <p className="mb-3 text-xs font-medium text-muted-foreground">
        Question ·{" "}
        {record.status === "unknown" ? "Answer unavailable" : record.status}
      </p>
      <div className="space-y-4">
        {record.payload.questions.map((q) => (
          <section key={q.id} className="space-y-2 text-sm">
            <Markdown content={q.prompt} />
            {q.details ? <Markdown content={q.details} /> : null}
            {q.options.length ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Options offered</summary>
                <ul className="mt-2 space-y-1">
                  {q.options.map((o) => (
                    <li key={o.value}>
                      <strong>{o.label}</strong> — {o.description}
                      {o.preview ? (
                        <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded border border-border p-2">
                          {o.preview}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <div className="rounded border border-border p-2">
              <strong className="text-xs">Your answer</strong>
              <p className="whitespace-pre-wrap text-sm">
                {record.result?.answers[q.prompt] ??
                  (record.status === "dismissed"
                    ? "Dismissed without an answer or approval"
                    : record.status === "pending"
                      ? "Awaiting your answer"
                      : "No answer was retained")}
              </p>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** BB owns the form row's position; the plugin renders only its saved body. */
export function QuestionHistoryInline({
  row,
  payload,
  Original,
}: PluginTimelineRendererProps) {
  const rpc = useRpc<RpcContract>();
  const [record, setRecord] = useState<QuestionHistory | null>(null);
  const parsed = questionResultSchema.safeParse(payload);
  const input = parsed.success
    ? toolInputSchema.safeParse({ questions: parsed.data.questions })
    : null;
  const direct: QuestionHistory | null =
    parsed.success && input?.success
      ? {
          id: row.id,
          at: row.startedAt,
          status: "answered",
          payload: buildInteractionPayload(input.data),
          result: parsed.data,
        }
      : null;
  const load = useCallback(async () => {
    const prefix = `${row.threadId}:form:`;
    if (!row.id.startsWith(prefix)) return;
    const value = await rpc
      .call("question_at", {
        threadId: row.threadId,
        interactionId: row.id.slice(prefix.length),
      })
      .catch(() => null);
    setRecord(value);
  }, [rpc, row.id, row.threadId]);
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("changed", () => void load());
  const saved = record ?? direct;
  return saved ? <QuestionHistoryCard record={saved} /> : <Original />;
}
