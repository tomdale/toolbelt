import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  useBbNavigate,
  useComposer,
  useRpc,
  useSdk,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import type {
  ComposerDraftSnapshot,
  ComposerMention,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { RouteDecision } from "../../server/router.ts";
import {
  NewWork as NewWorkModel,
  NewWorkContext,
  type NewWorkState,
} from "./new-work.ts";
import { useDebugMode } from "../debug/debug.ts";
import { NewWorkDebug } from "./NewWorkDebug.tsx";
import { createPortal } from "react-dom";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { useHostPickerRow } from "./host-picker-row.ts";
import { NewWorkBridge } from "./NewWorkBridge.tsx";
import { SuggestionRow } from "./Suggestion.tsx";
import { WorkstreamPicker } from "./WorkstreamPicker.tsx";

type PromptInput = NewThreadRequest["input"][number];
type PromptMention = Extract<PromptInput, { type: "text" }>["mentions"][number];
type PromptMentionResource = PromptMention["resource"];

function promptInputFromDraft(draft: ComposerDraftSnapshot): PromptInput[] {
  const leadingWhitespace = draft.text.length - draft.text.trimStart().length;
  const trailingEnd = draft.text.trimEnd().length;
  const text = draft.text.slice(leadingWhitespace, trailingEnd);
  const input: PromptInput[] = [];
  if (text) {
    const mentions = draft.mentions.flatMap((mention) => {
      const from = Math.max(mention.from, leadingWhitespace);
      const to = Math.min(mention.to, trailingEnd);
      return from < to
        ? [
            {
              start: from - leadingWhitespace,
              end: to - leadingWhitespace,
              resource: promptMentionResource(mention),
            },
          ]
        : [];
    });
    input.push({ type: "text", text, mentions });
  }
  for (const attachment of draft.attachments) {
    input.push(
      attachment.type === "localImage"
        ? { type: "localImage", path: attachment.path }
        : {
            type: "localFile",
            path: attachment.path,
            name: attachment.name,
            sizeBytes: attachment.sizeBytes,
            ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          },
    );
  }
  return input;
}

function promptMentionResource(
  mention: ComposerMention,
): PromptMentionResource {
  if (mention.kind === "plugin") {
    const { from: _from, to: _to, provider, id, ...rest } = mention;
    return { ...rest, kind: "plugin", itemId: `${provider}:${id}` };
  }
  const { from: _from, to: _to, ...resource } = mention;
  return resource as PromptMentionResource;
}

export function NewThreadRouting() {
  const rpc = useRpc<RpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const composer = useComposer();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [checkedRoot, setCheckedRoot] = useState(false);
  const [model, setModel] = useState<NewWorkModel | null>(null);
  const [composerRoot, setComposerRoot] = useState<HTMLElement | null>(null);
  const composerRef = useRef(composer);
  composerRef.current = composer;

  useEffect(() => {
    const primary = root?.closest<HTMLElement>(
      '[data-app-composer-role="primary"]',
    );
    if (!root) return;
    if (
      !primary ||
      primary.closest('[role="dialog"]') ||
      composer.scope.kind !== "new-thread"
    ) {
      setCheckedRoot(true);
      return;
    }
    setCheckedRoot(true);
    setComposerRoot(primary);
    const draftKey = composer.key;
    const nativeModel = new NewWorkModel(
      {
        route: async (prompt, _workstreamId, pickedProjectId) =>
          (await rpc.call("route", {
            prompt,
            pickedProjectId,
            suggest: true,
            offerNewThread: true,
            nativeComposer: true,
            draftKey,
          })) as RouteDecision,
        cancelRoute: () => {
          void rpc.call("routeCancel", { draftKey }).catch(() => {});
        },
        startThread: () => {
          throw new Error("The host new-thread composer submits this draft.");
        },
        sendToThread: async (threadId, input, traceId) => {
          await rpc.call("sendToThread", {
            threadId,
            input: JSON.parse(JSON.stringify(input)) as unknown[],
            traceId,
          });
        },
        sendDraftToThread: async (threadId, traceId) => {
          const current = composerRef.current;
          const target = await sdk.threads.get({ threadId });
          const paths = current.draft.attachments.map(
            (attachment) => attachment.path,
          );
          const sourceProjectId = current.selection?.projectId;
          if (
            paths.length &&
            sourceProjectId &&
            sourceProjectId !== target.projectId
          ) {
            await sdk.projects.attachments.copy({
              projectId: target.projectId,
              sourceProjectId,
              paths,
            });
          }
          const input = promptInputFromDraft(current.draft);
          if (!input.length) throw new Error("Type a message first.");
          await rpc.call("sendToThread", {
            threadId,
            input: JSON.parse(JSON.stringify(input)) as unknown[],
            traceId,
          });
          current.replace({ text: "", mentions: [], attachments: [] });
          navigate.toThread(threadId);
        },
      },
      null,
      true,
    );
    nativeModel.attach(composer);
    nativeModel.observe(composer.text);
    nativeModel.observeSelection(composer.selection);
    setModel(nativeModel);
    return () => {
      nativeModel.dispose();
      setModel((current) => (current === nativeModel ? null : current));
      setComposerRoot(null);
    };
  }, [composer, composer.scope.kind, navigate, root, rpc, sdk]);

  useEffect(() => {
    if (!model) return;
    model.observe(composer.text);
    model.observeSelection(composer.selection);
  }, [composer.selection, composer.text, model]);

  const state = useSyncExternalStore(
    model?.subscribe ?? emptySubscribe,
    model?.snapshot ?? emptySnapshot,
  );
  // BB's Enter submits without a form event this banner could intercept, so
  // the server also learns the draft's identity as it changes and files the
  // thread whose first message has this text (`ComposedDrafts`).
  const draftKey = composer.key;
  useEffect(() => {
    if (!model) return;
    const identity = state.identity
      ? {
          entityId: state.identity.entityId,
          proposal: state.identity.proposal,
          provenance: state.identity.provenance,
        }
      : null;
    void Promise.resolve()
      .then(() =>
        rpc.call("draftIdentity", { draftKey, text: state.text, identity }),
      )
      .catch(() => {
        // The submit data or automatic classification still files the thread.
      });
  }, [draftKey, model, rpc, state.identity, state.text]);
  useEffect(() => {
    // The host composer submits through BB's own thread creation; the
    // destination the pickers show — picked or automatic — travels as submit
    // metadata the server's dispatch hook files.
    const current = model ? model.snapshot() : null;
    if (!model || !current) return;
    if (
      !current.identity &&
      !current.decision
    )
      return;
    const primary = root?.closest<HTMLElement>(
      '[data-app-composer-role="primary"]',
    );
    const form = primary?.querySelector<HTMLFormElement>(
      "form[data-promptbox]",
    );
    if (!form || primary?.closest('[role="dialog"]')) return;
    const submit = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void (async () => {
        try {
          const snapshot = model.snapshot();
          const identity = snapshot.identity
            ? {
                entityId: snapshot.identity.entityId,
                proposal: snapshot.identity.proposal,
                provenance: snapshot.identity.provenance,
              }
            : null;
          const experimental_data: Record<string, unknown> = {};
          if (identity) experimental_data.identity = identity;
          await composerRef.current.submit({
            experimental_data: Object.keys(experimental_data).length
              ? (experimental_data as Record<string, unknown> as any)
              : null,
          });
        } catch (error) {
          model.reportError(error);
        }
      })();
    };
    form.addEventListener("submit", submit, true);
    return () => form.removeEventListener("submit", submit, true);
  }, [
    composer,
    model,
    root,
    state.identity,
    state.decision,
  ]);
  // The picker row sits below the prompt box, outside this banner, so on a
  // wide screen the field is portaled into it. A phone's row is full with BB's
  // own project, environment and branch chips, so there the field takes a line
  // of its own in this banner, above the prompt box. The status text is then
  // announced but not drawn; the chip's ✦ pulses while it classifies.
  const compact = useIsCompactViewport();
  const pickerRow = useHostPickerRow(model && !compact ? composerRoot : null);
  const picker = model ? (
    <>
      <WorkstreamPicker newWork={model} />
      <span
        role="status"
        aria-live="polite"
        className={
          compact ? "sr-only" : "ws-picker-status text-xs text-muted-foreground"
        }
      >
        {state.classifying ? "Classifying…" : ""}
      </span>
    </>
  ) : null;
  return checkedRoot && !model ? null : (
    <div ref={setRoot}>
      {model ? (
        <NewWorkContext.Provider value={model}>
          <NewWorkBridge />
          <div className="ws-native-new-thread-routing">
            {pickerRow ? (
              createPortal(picker, pickerRow)
            ) : (
              <div
                className={
                  compact
                    ? "ws-route-strip"
                    : "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3.5"
                }
              >
                {picker}
              </div>
            )}
            {/* The row also shows the model's error, as in New work. */}
            <SuggestionRow newWork={model} />
            <DebugSection newWork={model} />
          </div>
        </NewWorkContext.Provider>
      ) : null}
    </div>
  );
}

/** New work's Debug section, mounted only once the banner is active. */
function DebugSection({ newWork }: { newWork: NewWorkModel }) {
  return useDebugMode() ? <NewWorkDebug newWork={newWork} /> : null;
}

function emptySubscribe() {
  return () => {};
}

const emptySnapshot = () => EMPTY_STATE;
const EMPTY_STATE: NewWorkState = {
  text: "",
  identity: null,
  selection: null,
  suggestion: null,
  decision: null,
  classifying: false,
  settled: null,
  accepting: false,
  error: null,
  errors: 0,
  events: [],
};
