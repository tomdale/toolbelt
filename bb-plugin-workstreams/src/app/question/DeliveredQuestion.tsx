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
  text: string;
  record: QuestionHistory | null;
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
          host.classList.remove("ws-delivered-question-source");
          mounted.delete(host);
          changed = true;
          continue;
        }
        const text = (host.textContent ?? "").trimStart();
        if (text !== target.text) {
          const record = deliveredCardRecord(text);
          const isClippedPreview =
            !record && (text.endsWith("…") || text.endsWith("..."));
          if (record || isClippedPreview) {
            target.text = text;
            target.record = record;
            changed = true;
          }
        }
      }
      for (const row of document.querySelectorAll<HTMLElement>(
        "[data-timeline-row-id]",
      )) {
        if (row.querySelector("[data-ws-delivered-anchor]")) continue;
        // Match an element whose own text begins with the transport prefix.
        // The card anchor lives beside that element, so the host's renderer can
        // hide it whether BB emitted nested markup or a direct text node.
        const candidates = Array.from(
          row.querySelectorAll<HTMLElement>("*"),
        ).reverse();
        for (const host of candidates) {
          if (host.closest("[data-ws-delivered-anchor]") || mounted.has(host))
            continue;
          const text = (host.textContent ?? "").trimStart();
          if (!text.startsWith(PREFIX)) continue;
          const record = deliveredCardRecord(text);
          // BB's collapsed generated-message preview clips the delivered JSON,
          // so it cannot produce a complete card until the row is expanded.
          // Replace that transport excerpt with a useful inline affordance;
          // clicking it still bubbles to BB's preview expansion handler.
          const isClippedPreview =
            !record && (text.endsWith("…") || text.endsWith("..."));
          if (!record && !isClippedPreview) continue;
          const anchor = document.createElement("div");
          anchor.dataset.wsDeliveredAnchor = "";
          host.after(anchor);
          host.classList.add("ws-delivered-question-source");
          mounted.set(host, { host, anchor, text, record });
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
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    scan();
    return () => {
      active = false;
      observer.disconnect();
      for (const { host, anchor } of mounted.values()) {
        host.classList.remove("ws-delivered-question-source");
        anchor.remove();
      }
    };
  }, []);
  return (
    <>
      {targets.map(({ anchor, record }, index) =>
        createPortal(
          record ? (
            <QuestionHistoryCard record={record} />
          ) : (
            <span className="ws-delivered-question-preview">
              Expand to view the question and answer
            </span>
          ),
          anchor,
          String(index),
        ),
      )}
    </>
  );
}
