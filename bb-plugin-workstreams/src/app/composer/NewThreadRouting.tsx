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
import { NewWork as NewWorkModel, NewWorkContext } from "./new-work.ts";
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
    const draftKey = composer.key;
    const nativeModel = new NewWorkModel(
      {
        route: async (prompt, selectedWorkstreamId, pickedProjectId) =>
          (await rpc.call("route", {
            prompt,
            selectedWorkstreamId,
            pickedProjectId,
            suggest: true,
            offerNewThread: true,
            nativeComposer: true,
            draftKey,
          })) as RouteDecision,
        cancelRoute: () => {
          void rpc.call("routeCancel", { draftKey }).catch(() => {});
        },
        createWorkstream: async (name, description) => {
          const created = await rpc.call("createWorkstream", {
            name,
            ...(description ? { description } : {}),
          });
          return {
            sectionId: created.sectionId,
            name: created.entry.workstreams[0]?.name ?? name,
          };
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
        submitWithRoute: (routeId, sectionId) =>
          composerRef.current.submit({
            experimental_data: { routeId, ...(sectionId ? { sectionId } : {}) },
          }),
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
  useEffect(() => {
    if (!model?.snapshot().workstreamWasExplicit) return;
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
      const sectionId = model.snapshot().workstream?.id;
      void composerRef.current.submit({
        experimental_data: sectionId ? { sectionId } : null,
      });
    };
    form.addEventListener("submit", submit, true);
    return () => form.removeEventListener("submit", submit, true);
  }, [composer, model, root, state.workstream, state.workstreamWasExplicit]);
  return checkedRoot && !model ? null : (
    <div ref={setRoot}>
      {model ? (
        <NewWorkContext.Provider value={model}>
          <NewWorkBridge />
          <div className="ws-native-new-thread-routing">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3.5">
              <span className="text-xs text-muted-foreground">
                New thread in
              </span>
              <WorkstreamPicker newWork={model} />
              <span
                role="status"
                aria-live="polite"
                className="ml-auto text-xs text-muted-foreground"
              >
                {state.classifying ? "Classifying…" : ""}
              </span>
            </div>
            <SuggestionRow newWork={model} />
            {state.error ? (
              <p role="alert" className="px-3.5 text-sm text-destructive">
                {state.error}
              </p>
            ) : null}
          </div>
        </NewWorkContext.Provider>
      ) : null}
    </div>
  );
}

function emptySubscribe() {
  return () => {};
}

const emptySnapshot = () => EMPTY_STATE;
const EMPTY_STATE = {
  text: "",
  workstream: null,
  selection: null,
  suggestion: null,
  decision: null,
  workstreamWasExplicit: false,
  autoPlacement: null,
  classifying: false,
  settled: null,
  accepting: false,
  error: null,
  errors: 0,
  events: [],
} as const;
