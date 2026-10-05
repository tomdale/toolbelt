import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { Preview } from "../../server/preview.ts";
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
import { WorkstreamPicker } from "./WorkstreamPicker.tsx";
import { takeComposerPreset } from "./preset.ts";

export function NewThreadRouting() {
  const rpc = useRpc<RpcContract>();
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
    const nativeModel = new NewWorkModel({
      route: async (prompt, pickedProjectId) =>
        (await rpc.call("preview", {
          prompt,
          pickedProjectId,
          draftKey,
        })) as Preview,
      cancelRoute: () => {
        void rpc.call("previewCancel", { draftKey }).catch(() => {});
      },
    });
    // Opened from a workstream's ＋: the thread starts with its topic.
    const preset = takeComposerPreset();
    if (preset) nativeModel.selectWorkstream(preset.sectionId, preset.label);
    nativeModel.observe(composer.text);
    nativeModel.observeSelection(composer.selection);
    setModel(nativeModel);
    return () => {
      nativeModel.dispose();
      setModel((current) => (current === nativeModel ? null : current));
      setComposerRoot(null);
    };
  }, [composer, composer.scope.kind, root, rpc]);

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
    const identity = submittedIdentity(state);
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
    if (!current.identity && !current.decision) return;
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
          const identity = submittedIdentity(model.snapshot());
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
  }, [composer, model, root, state.identity, state.decision]);
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
        {state.classifying ? "Analyzing…" : ""}
      </span>
    </>
  ) : null;
  return checkedRoot && !model ? null : (
    <div ref={setRoot}>
      {model ? (
        <NewWorkContext.Provider value={model}>
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
            {state.error ? (
              <p
                key={state.errors}
                role="alert"
                className="ws-suggestion-error"
              >
                {state.error}
              </p>
            ) : null}
            <DebugSection newWork={model} />
          </div>
        </NewWorkContext.Provider>
      ) : null}
    </div>
  );
}

/** What the server files the thread with: the topic the field shows. */
function submittedIdentity(state: NewWorkState) {
  const identity = state.identity;
  if (!identity) return null;
  return {
    entityId: identity.entityId,
    proposal: identity.proposal,
    provenance: identity.provenance,
    ...(identity.sectionId ? { sectionId: identity.sectionId } : {}),
    // Quick analysis's title travels with its topic, so the server doesn't
    // ask again for the same text.
    ...(identity.provenance === "automatic"
      ? { goal: state.decision?.goal ?? null }
      : {}),
  };
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
  decision: null,
  classifying: false,
  error: null,
  errors: 0,
  events: [],
};
