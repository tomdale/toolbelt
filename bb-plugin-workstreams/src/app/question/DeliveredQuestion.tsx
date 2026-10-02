import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  deliveredQuestionResult,
  type QuestionHistory,
} from "../../server/questions/history.ts";
import { buildInteractionPayload } from "../../server/questions/translate.ts";
import { toolInputSchema } from "../../server/questions/contracts.ts";
import { QuestionHistoryCard } from "./QuestionHistory.tsx";

const PREFIX =
  "Your earlier AskUserQuestion tool call has finished. Its result:";

/** Generated system messages bypass BB's plugin renderer slots. Match only
 * a complete question result, and leave host-owned DOM in place for cleanup. */
export function deliveredCardRecord(text: string): QuestionHistory | null {
  const start = text.indexOf(PREFIX);
  if (start < 0) return null;
  const json = text.slice(start + PREFIX.length).trim();
  const result = deliveredQuestionResult(`${PREFIX}\n\n${json}`);
  if (!result) return null;
  const input = toolInputSchema.safeParse({ questions: result.questions });
  if (!input.success) return null;
  return {
    id: "delivered",
    at: null,
    status: "answered",
    payload: buildInteractionPayload(input.data),
    result,
  };
}

type Target = {
  host: HTMLElement;
  anchor: HTMLElement;
  record: QuestionHistory;
};

export function DeliveredQuestionCards() {
  const [targets, setTargets] = useState<Target[]>([]);
  useEffect(() => {
    const mounted = new Map<HTMLElement, Target>();
    let scheduled = false;
    let active = true;
    const scan = () => {
      scheduled = false;
      if (!active) return;
      let changed = false;
      for (const [host, target] of mounted) {
        if (!host.isConnected) {
          target.anchor.remove();
          host.classList.remove("ws-delivered-question");
          mounted.delete(host);
          changed = true;
        }
      }
      for (const row of document.querySelectorAll<HTMLElement>(
        "[data-timeline-row-id]",
      )) {
        if (row.querySelector("[data-ws-delivered-anchor]")) continue;
        // The smallest complete body excludes the generated-message title and
        // cannot mistake snippets in tool command text for a delivered answer.
        const candidates = Array.from(
          row.querySelectorAll<HTMLElement>("div"),
        ).reverse();
        for (const host of candidates) {
          if (host.closest("[data-ws-delivered-anchor]") || mounted.has(host))
            continue;
          const text = host.textContent ?? "";
          if (!text.trimStart().startsWith(PREFIX)) continue;
          const record = deliveredCardRecord(text);
          if (!record) continue;
          const anchor = document.createElement("div");
          anchor.dataset.wsDeliveredAnchor = "";
          host.append(anchor);
          host.classList.add("ws-delivered-question");
          mounted.set(host, { host, anchor, record });
          changed = true;
          break;
        }
      }
      if (changed) setTargets([...mounted.values()]);
    };
    const observer = new MutationObserver(() => {
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(scan);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true });
    scan();
    return () => {
      active = false;
      observer.disconnect();
      for (const { host, anchor } of mounted.values()) {
        host.classList.remove("ws-delivered-question");
        anchor.remove();
      }
    };
  }, []);
  return (
    <>
      {targets.map(({ anchor, record }, index) =>
        createPortal(
          <QuestionHistoryCard record={record} />,
          anchor,
          String(index),
        ),
      )}
    </>
  );
}
