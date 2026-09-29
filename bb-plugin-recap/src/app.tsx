import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Markdown,
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useComposerView,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalProviderModelPickerValue,
  PluginSettingsSectionProps,
  PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import {
  DEFAULT_RECAP_PROMPT,
  isBlankRecapPrompt,
  MAX_CONCURRENT_GENERATIONS,
  MAX_RECAP_PROMPT_CHARS,
  MIN_CONCURRENT_GENERATIONS,
  normalizeRecapSettings,
  parseClampedInteger,
  recapFormIsDirty,
  settingsFormStatus,
  settingsFormStatusLabel,
  shouldShowRecapBanner,
} from "./recap";
import type { ModelSelection, Recap, RecapSettings, rpcContract } from "./server";

const RECAP_CHANGED = "recap-changed";

function generationErrorMessage(reason: string | null): string {
  switch (reason) {
    case "no_conversation":
      return "There is no conversation to recap yet.";
    case "not_enough_turns":
      return "There are not enough user turns for an automatic recap yet.";
    case "hidden_thread":
      return "Recaps cannot be generated for hidden threads.";
    case "already_exists":
      return "A recap already exists for this conversation state.";
    case "already_generating":
      return "A recap is already being generated.";
    case "stale":
      return "The thread changed while the recap was generating. Try again.";
    case "aborted":
      return "Recap generation was cancelled.";
    case "empty_model_response":
      return "The recap model returned no usable summary.";
    case "suppressed":
      return "This recap was suppressed because the model response was too long.";
    default:
      return reason ? `Could not generate a recap (${reason}).` : "No recap was generated.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkboxFromInput(
  event: { currentTarget: EventTarget | null; target: EventTarget },
): boolean {
  const element = event.currentTarget instanceof HTMLInputElement
    ? event.currentTarget
    : event.target instanceof HTMLInputElement
      ? event.target
      : null;
  return element?.checked ?? false;
}

function textFromInput(
  event: { currentTarget: EventTarget | null; target: EventTarget },
): string {
  const element = event.currentTarget instanceof HTMLTextAreaElement || event.currentTarget instanceof HTMLInputElement
    ? event.currentTarget
    : event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement
      ? event.target
      : null;
  return element?.value ?? "";
}

function useRecapSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [settings, setSettings] = useState<RecapSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  const applySettings = useCallback((value: unknown) => {
    setSettings(normalizeRecapSettings(value));
  }, []);

  const reload = useCallback(async (background = false) => {
    if (!background) setIsLoading(true);
    try {
      applySettings(await rpcRef.current.call("recap_settings_get", {}));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!background) setIsLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    void reload(false);
  }, [reload]);
  const onSettingsSignal = useCallback((payload: unknown) => {
    if (isRecord(payload) && payload.settings === true) void reload(true);
  }, [reload]);
  useRealtime(RECAP_CHANGED, onSettingsSignal);

  return { settings, setSettings, isLoading, error };
}

function useThreadRecap(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [recap, setRecap] = useState<Recap | null>(null);
  const [generating, setGenerating] = useState(false);

  const reload = useCallback(async () => {
    try {
      const next = await rpc.call("recap_get", { threadId });
      setRecap(next.recap);
      setGenerating(next.generating);
    } catch {
      // Keep the last known recap; the next realtime signal retries.
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onSignal = useCallback((payload: unknown) => {
    if (isRecord(payload) && payload.threadId === threadId) void reload();
  }, [reload, threadId]);
  useRealtime(RECAP_CHANGED, onSignal);

  /** Generates a manual recap and returns its result for inline and header actions. */
  const generate = useCallback(async (): Promise<{ recap: Recap | null; error: string | null }> => {
    setGenerating(true);
    try {
      const next = await rpc.call("recap_generate", { threadId, automatic: false });
      setRecap(next.recap);
      return {
        recap: next.recap,
        error: !next.recap ? generationErrorMessage(next.reason) : null,
      };
    } catch (cause) {
      return {
        recap: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      setGenerating(false);
      void reload();
    }
  }, [reload, rpc, threadId]);

  return { recap, generating, generate };
}

/** Quiet period after a turn ends before the inline Generate Recap action appears. */
const THREAD_SETTLE_MS = 1_500;

/**
 * True once the composer has been idle for THREAD_SETTLE_MS. It drops to false
 * as soon as a turn is submitted or running, so brief idle gaps between agent
 * steps do not flash the action. A thread that is already idle on mount counts
 * as settled immediately.
 */
function useThreadSettled(): boolean {
  const { run } = useComposerView();
  const busy = run.isRunning || run.isSubmitting;
  const [settled, setSettled] = useState(!busy);
  useEffect(() => {
    if (busy) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), THREAD_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  return settled && !busy;
}

const RECAP_BANNER_CLASS =
  "relative mx-auto mb-3 w-full min-w-0 max-w-4xl rounded-lg border border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800/70 dark:bg-sky-950/60 dark:text-sky-200";

/**
 * Inline recap above the composer. With automatic recaps on, it shows the
 * latest recap. With them off, it shows an inline Generate Recap action once
 * the thread has settled, a progress placeholder while that just-in-time
 * recap generates, and then the recap itself; automatic recaps left over from
 * before the setting changed stay hidden. Errors surface as notifications.
 * Dismissal is keyed by recap id and held in component state, so a newer
 * recap reappears.
 */
function RecapComposerBannerContent({
  threadId,
  automatic,
}: {
  threadId: string;
  automatic: boolean;
}) {
  const { recap, generating, generate } = useThreadRecap(threadId);
  const [dismissedRecapId, setDismissedRecapId] = useState<string | null>(null);
  const [requestedRecap, setRequestedRecap] = useState(false);
  const settled = useThreadSettled();

  // A new turn invalidates the requested recap, so return to the inline action
  // for the next settled point instead of leaving an empty slot.
  useEffect(() => {
    if (!settled && !generating) setRequestedRecap(false);
  }, [generating, settled]);

  const runJustInTimeRecap = useCallback(async () => {
    setRequestedRecap(true);
    const result = await generate();
    if (result.error) {
      setRequestedRecap(false);
      toast.error(result.error);
    }
  }, [generate]);

  const onRequest = !automatic;

  if (onRequest && requestedRecap && generating) {
    // Occupies the recap's slot at a similar size so the finished recap
    // replaces it in place instead of popping in below an empty gap.
    return (
      <div
        className={`${RECAP_BANNER_CLASS} px-3.5 py-2.5`}
        role="status"
        aria-live="polite"
        aria-label="Generating recap"
      >
        <div className="flex items-center gap-2 text-xs font-medium text-sky-900/70 dark:text-sky-200/70">
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 animate-spin" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
            <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Generating recap…
        </div>
        <div aria-hidden="true" className="mt-2 space-y-1.5 animate-pulse">
          <div className="h-2 w-full rounded-full bg-sky-900/10 dark:bg-sky-200/15" />
          <div className="h-2 w-4/5 rounded-full bg-sky-900/10 dark:bg-sky-200/15" />
        </div>
      </div>
    );
  }

  const visibleRecap =
    recap &&
    recap.id !== dismissedRecapId &&
    (!onRequest || !recap.automatic || requestedRecap)
      ? recap
      : null;

  if (!visibleRecap) {
    if (!onRequest || !settled) return null;
    return (
      <div className="mx-auto mb-3 flex w-full min-w-0 max-w-4xl justify-center">
        <button
          type="button"
          className="cursor-pointer rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
          disabled={generating}
          onClick={() => void runJustInTimeRecap()}
        >
          {generating ? "Generating recap…" : "Generate Recap"}
        </button>
      </div>
    );
  }

  return (
    <div className={`${RECAP_BANNER_CLASS} px-3.5 py-2.5`} role="region" aria-label="Latest recap">
      <Markdown content={visibleRecap.summary} className="text-sm leading-6 text-inherit" />
      <button
        type="button"
        className="absolute right-1.5 top-1.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-sky-900/50 transition-colors hover:bg-sky-900/10 hover:text-sky-900/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 dark:text-sky-200/50 dark:hover:bg-sky-200/10 dark:hover:text-sky-200/80"
        aria-label="Dismiss recap"
        title="Dismiss recap"
        onClick={() => {
          setDismissedRecapId(visibleRecap.id);
          setRequestedRecap(false);
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}

function RecapComposerBanner() {
  const { scope } = useComposerView();
  const { settings, isLoading } = useRecapSettings();
  const bannerRef = useRef<HTMLDivElement>(null);
  const [isInlineMessageEditor, setIsInlineMessageEditor] = useState(false);

  // ponytail: BB DOM-marker fallback; switch to ComposerView edit state when the host exposes it.
  useLayoutEffect(() => {
    const next = Boolean(bannerRef.current?.closest("[data-inline-message-editor-frame]"));
    setIsInlineMessageEditor((current) => current === next ? current : next);
  }, [isInlineMessageEditor, scope.kind]);

  if (scope.kind !== "thread") return null;
  const showBanner = shouldShowRecapBanner(scope.kind, isInlineMessageEditor);
  const content =
    !isLoading && settings && showBanner
      ? <RecapComposerBannerContent threadId={scope.threadId} automatic={settings.auto} />
      : null;
  return (
    <div ref={bannerRef} className="contents">
      {content}
    </div>
  );
}

function pickerValueFromSelection(selection: ModelSelection | null): ExperimentalProviderModelPickerValue | null {
  if (
    !selection ||
    typeof selection.providerId !== "string" ||
    typeof selection.model !== "string" ||
    typeof selection.reasoningLevel !== "string"
  ) {
    return null;
  }
  return {
    providerId: selection.providerId,
    model: selection.model,
    reasoningLevel: selection.reasoningLevel,
    ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
  };
}

function BoundedNumberInput({
  value,
  min,
  max,
  fallback,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  fallback: number;
  disabled?: boolean;
  onCommit: (next: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const display = text ?? String(value);

  const handleChange = (event: { currentTarget: EventTarget | null; target: EventTarget }) => {
    const raw = textFromInput(event);
    setText(raw);
    if (/^-?\d+$/.test(raw.trim())) {
      onCommit(parseClampedInteger(raw, fallback, min, max));
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={display}
      disabled={disabled}
      onChange={handleChange}
      onBlur={() => setText(null)}
      className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

function SettingsSection(_props: PluginSettingsSectionProps) {
  return <SettingsSectionBody />;
}

function SettingsSectionBody() {
  const rpc = useRpc<typeof rpcContract>();
  const {
    settings,
    setSettings: setLoadedSettings,
    isLoading: settingsLoading,
    error: settingsLoadError,
  } = useRecapSettings();
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [configured, setConfigured] = useState(false);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [localDraft, setLocalDraft] = useState<RecapSettings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  const loadModel = useCallback(async (background = false) => {
    if (!background) setModelLoading(true);
    try {
      const next = await rpcRef.current.call("recap_model_get", {});
      setSelection(next.selection);
      setConfigured(next.configured);
      setModelError(null);
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!background) setModelLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModel(false);
  }, [loadModel]);
  const onModelSettingsSignal = useCallback((payload: unknown) => {
    if (isRecord(payload) && payload.settings === true) void loadModel(true);
  }, [loadModel]);
  useRealtime(RECAP_CHANGED, onModelSettingsSignal);

  const draft = settings ? (localDraft ?? settings) : null;
  const settingsDirty = localDraft !== null && settings !== null && recapFormIsDirty(localDraft, settings);

  const onModelChange = useCallback((next: ExperimentalProviderModelPickerValue) => {
    const nextSelection: ModelSelection = {
      providerId: next.providerId,
      model: next.model,
      reasoningLevel: next.reasoningLevel,
      ...(next.serviceTier ? { serviceTier: next.serviceTier } : {}),
    };
    setSelection(nextSelection);
    setModelSaving(true);
    setModelError(null);
    void rpc.call("recap_model_set", nextSelection)
      .then((result) => {
        setSelection(result.selection);
        setConfigured(true);
      })
      .catch((cause) => {
        setModelError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setModelSaving(false));
  }, [rpc]);

  const updateDraft = useCallback((update: (current: RecapSettings) => RecapSettings) => {
    if (!settings) return;
    setLocalDraft((current) => {
      const next = update(current ?? settings);
      return recapFormIsDirty(next, settings) ? next : null;
    });
    setSettingsError(null);
  }, [settings]);


  const pickerValue = pickerValueFromSelection(selection);

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Choose the recap model with BB's native provider/model picker. With no saved choice, recaps use BB's primary default model.
      </p>
      {modelLoading ? (
        <p className="text-xs text-muted-foreground">Loading BB models…</p>
      ) : pickerValue ? (
        <ProviderModelPicker
          value={pickerValue}
          onChange={onModelChange}
          align="start"
          className="w-full"
          disabled={modelSaving}
        />
      ) : (
        <p role="alert" className="text-sm text-destructive">BB's model catalog is unavailable.</p>
      )}
      {modelError ? <p role="alert" className="text-sm text-destructive">{modelError}</p> : null}
      {selection ? (
        <p className="text-xs text-muted-foreground">
          {configured ? "Saved selection" : "BB primary default"} · {selection.providerId}/{selection.model} · {selection.reasoningLevel} reasoning
          {selection.serviceTier ? " · " + selection.serviceTier + " service tier" : ""}
        </p>
      ) : null}
      {settingsLoadError ? <p role="alert" className="text-sm text-destructive">{settingsLoadError}</p> : null}
      {settingsLoading || !draft ? (
        <p className="text-xs text-muted-foreground">Loading recap settings…</p>
      ) : (
        <>
        <form
          className="space-y-5 border-t border-border pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            const promptBlank = isBlankRecapPrompt(draft.prompt);
            if (!settingsDirty || settingsSaving || promptBlank) return;
            setSettingsSaving(true);
            setSettingsError(null);
            void rpc.call("recap_settings_set", draft)
              .then((saved) => {
                setLoadedSettings(normalizeRecapSettings(saved));
                setLocalDraft(null);
              })
              .catch((cause) => {
                setSettingsError(cause instanceof Error ? cause.message : String(cause));
              })
              .finally(() => setSettingsSaving(false));
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium text-foreground">Automatic recaps</p>
              <p className="text-xs text-muted-foreground">
                {draft.auto
                  ? "Show a recap above the composer after the thread has been idle."
                  : "Off: a Generate Recap button appears above the composer instead."}
              </p>
            </div>
            <input
              type="checkbox"
              aria-label="Automatic recaps"
              checked={draft.auto}
              onChange={(event) => {
                const auto = checkboxFromInput(event);
                updateDraft((current) => ({ ...current, auto }));
              }}
              className="mt-0.5 h-4 w-4 accent-foreground"
            />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium text-foreground">Auto-clean up recaps</p>
              <p className="text-xs text-muted-foreground">Keep only the newest 1,000 visible recaps.</p>
            </div>
            <input
              type="checkbox"
              aria-label="Auto-clean up recaps"
              checked={draft.autoCleanup}
              onChange={(event) => {
                const autoCleanup = checkboxFromInput(event);
                updateDraft((current) => ({ ...current, autoCleanup }));
              }}
              className="mt-0.5 h-4 w-4 accent-foreground"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="block font-medium text-foreground">Idle delay (seconds)</span>
              <BoundedNumberInput
                value={draft.afterSeconds}
                min={0}
                max={86_400}
                fallback={0}
                disabled={settingsSaving}
                onCommit={(afterSeconds) => updateDraft((current) => ({ ...current, afterSeconds }))}
              />
              <span className="block text-xs text-muted-foreground">Wait this long after activity stops.</span>
            </label>
            <label className="space-y-1.5">
              <span className="block font-medium text-foreground">Minimum user turns</span>
              <BoundedNumberInput
                value={draft.minTurns}
                min={1}
                max={100}
                fallback={1}
                disabled={settingsSaving}
                onCommit={(minTurns) => updateDraft((current) => ({ ...current, minTurns }))}
              />
              <span className="block text-xs text-muted-foreground">Start automatically at this many user turns.</span>
            </label>
            <label className="space-y-1.5">
              <span className="block font-medium text-foreground">Max concurrent recaps</span>
              <BoundedNumberInput
                value={draft.maxConcurrent}
                min={MIN_CONCURRENT_GENERATIONS}
                max={MAX_CONCURRENT_GENERATIONS}
                fallback={MIN_CONCURRENT_GENERATIONS}
                disabled={settingsSaving}
                onCommit={(maxConcurrent) => updateDraft((current) => ({ ...current, maxConcurrent }))}
              />
              <span className="block text-xs text-muted-foreground">How many recap workers may run at once.</span>
            </label>
          </div>
          <label className="space-y-1.5">
            <span className="block font-medium text-foreground">Recap prompt</span>
            <span className="block text-xs text-muted-foreground">Instructions sent to the recap model.</span>
            <div className="relative">
              <textarea
                value={draft.prompt}
                rows={6}
                maxLength={MAX_RECAP_PROMPT_CHARS}
                spellCheck={false}
                aria-describedby="recap-prompt-count"
                onChange={(event) => {
                  const prompt = textFromInput(event);
                  updateDraft((current) => ({ ...current, prompt }));
                }}
                className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 pb-8 text-sm leading-5 text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <p
                id="recap-prompt-count"
                className={MAX_RECAP_PROMPT_CHARS - draft.prompt.length < 200
                  ? "pointer-events-none absolute bottom-2 right-2 rounded-md bg-background/90 px-1.5 py-0.5 text-[11px] tabular-nums text-destructive"
                  : "pointer-events-none absolute bottom-2 right-2 rounded-md bg-background/90 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground"}
              >
                {draft.prompt.length.toLocaleString()} / {MAX_RECAP_PROMPT_CHARS.toLocaleString()}
                {" · "}
                {(MAX_RECAP_PROMPT_CHARS - draft.prompt.length).toLocaleString()} left
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => updateDraft((current) => ({ ...current, prompt: DEFAULT_RECAP_PROMPT }))}
                disabled={draft.prompt === DEFAULT_RECAP_PROMPT || settingsSaving}
              >
                Reset to default
              </button>
            </div>
            {isBlankRecapPrompt(draft.prompt) ? (
              <p role="alert" className="text-sm text-destructive">
                Prompt cannot be empty. Save is disabled so the default is not restored silently. Use Reset to default if you want the built-in instructions.
              </p>
            ) : null}
          </label>
          {settingsError ? <p role="alert" className="text-sm text-destructive">{settingsError}</p> : null}
          <div className="flex items-center justify-between gap-3 pt-8">
            <p role="status" className="text-xs text-muted-foreground">
              {settingsFormStatusLabel(settingsFormStatus(settingsSaving, settingsDirty))}
            </p>
            <button
              type="submit"
              className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!settingsDirty || settingsSaving || isBlankRecapPrompt(draft.prompt)}
            >
              Save settings
            </button>
          </div>
        </form>
        </>
      )}
    </div>
  );
}

/**
 * Manual generators for threads whose header is mounted, so the command
 * palette (which has no RPC client) can trigger the same generation flow.
 */
const headerGenerators = new Map<string, () => void>();

function RecapHeaderAction({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { generating, generate } = useThreadRecap(threadId);
  const run = useCallback(() => {
    void generate().then(({ error }) => {
      if (error) toast.error(error);
    });
  }, [generate]);

  useEffect(() => {
    headerGenerators.set(threadId, run);
    return () => {
      if (headerGenerators.get(threadId) === run) headerGenerators.delete(threadId);
    };
  }, [run, threadId]);

  return (
    <button
      type="button"
      className="inline-flex h-7 cursor-pointer items-center justify-center rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
      aria-label={generating ? "Generating recap" : "Generate recap"}
      title={generating ? "Generating recap…" : "Generate recap"}
      disabled={generating}
      onClick={run}
    >
      {isCompactViewport ? "✦" : generating ? "Recapping…" : "Recap"}
    </button>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "recap-banner",
    banners: [{ id: "recap", chrome: "bare", component: RecapComposerBanner }],
  });
  app.slots.settingsSection({
    id: "settings",
    title: "Recap behavior",
    description: "Choose the model, automatic behavior, and cleanup.",
    component: SettingsSection,
  });
  app.slots.experimental_threadHeaderAction({
    id: "recap",
    title: "Recap",
    component: RecapHeaderAction,
  });
  app.slots.commandPaletteAction({
    id: "generate",
    title: "Recap: generate for this thread",
    isAvailable: ({ threadId }) => threadId !== null && headerGenerators.has(threadId),
    run: ({ threadId }) => {
      if (threadId !== null) headerGenerators.get(threadId)?.();
    },
  });
});
