/**
 * New work's second submit: sends the draft to the thread the router
 * suggested, from the composer's action row beside Create thread. ⌘⏎
 * (Ctrl+⏎ elsewhere), the alternate send in bb's composers, does the same.
 * It renders only inside New work, and only while there is a suggestion.
 *
 * The thread's title is in the tooltip and accessible name rather than the
 * label: the action row's width comes out of the model picker beside it.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { buttonVariants } from "@/components/ui/button";
import { COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { IntakeContext, type Intake } from "./intake.ts";

export function isContinueShortcut(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing
  );
}

function macKeyboard(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  );
}

/**
 * The host binds its submit handler to the props of its last commit, so a
 * submit issued before the dialog re-renders with the new target would still
 * see the new-thread route's enabled state.
 */
const afterHostCommit = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export function ContinueAction() {
  const intake = useContext(IntakeContext);
  return intake ? <ContinueButton intake={intake} /> : null;
}

function ContinueButton({ intake }: { intake: Intake }) {
  const composer = useComposer();
  const suggestion = useSyncExternalStore(
    intake.subscribe,
    () => intake.snapshot().suggestion,
  );
  const button = useRef<HTMLButtonElement>(null);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const send = useCallback(async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await intake.continueSuggestion();
      await afterHostCommit();
      await composer.submit({ experimental_data: null });
    } catch (error) {
      intake.continuationFailed(error);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [composer, intake]);
  useEffect(() => {
    if (!suggestion) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isContinueShortcut(event)) return;
      // Capturing on the document runs before the editor's own ⌘⏎ handling,
      // which would create the thread. Keys outside this dialog stay alone.
      const scope =
        button.current?.closest('[role="dialog"]') ??
        button.current?.closest("form");
      if (!scope || !(event.target instanceof Node)) return;
      if (!scope.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      void send();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [suggestion, send]);
  if (!suggestion) return null;
  const mac = macKeyboard();
  const shortcut = mac ? "⌘⏎" : "Ctrl ⏎";
  const label = `Continue ${suggestion.threadTitle} instead`;
  return (
    // A plain button: the vendored Button omits `title`, the only place the
    // target thread's name is visible.
    <button
      ref={button}
      key={suggestion.threadId}
      type="button"
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
        "gap-1.5 font-normal text-muted-foreground hover:text-foreground",
      )}
      aria-label={label}
      aria-keyshortcuts={mac ? "Meta+Enter" : "Control+Enter"}
      aria-busy={sending}
      title={`${label} (${shortcut})`}
      disabled={sending || composer.isSubmitting}
      onClick={() => void send()}
    >
      <Icon name="CornerDownRight" aria-hidden />
      Continue
      <kbd className="shrink-0 font-sans text-[11px] text-muted-foreground">
        {shortcut}
      </kbd>
    </button>
  );
}
