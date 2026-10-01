/** Workstreams intake keeps the draft and its destination in one composer. */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  experimental_NewThreadComposer as Composer,
  useBbNavigate,
  useRpc,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import type { RpcContract } from "../../server/contract.ts";
import type { RouteDecision } from "../../server/router.ts";
import { Intake, IntakeContext } from "./intake.ts";
import { IntakeStatus } from "./IntakeBanner.tsx";
import { ContinueAction } from "./ContinueAction.tsx";

export function NewWorkDialog({
  open,
  onClose,
  workstreamId = null,
  workstreamName = null,
}: {
  open: boolean;
  onClose: () => void;
  workstreamId?: string | null;
  workstreamName?: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {/* Below md this is a drawer, which keeps its own safe-area padding. */}
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        className="max-w-[640px] md:p-5"
      >
        <div className="flex h-7 items-center justify-between gap-3">
          <DialogTitle className="leading-6">New work</DialogTitle>
          <DialogClose className="-mr-1.5 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:size-9">
            <Icon name="X" aria-hidden className="size-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>
        {open ? (
          <NewWork
            key={workstreamId ?? "auto"}
            {...{ onClose, workstreamId, workstreamName }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function extractPrompt(request: NewThreadRequest): string {
  return request.input
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n")
    .trim();
}

function NewWork({
  onClose,
  workstreamId,
  workstreamName,
}: {
  onClose: () => void;
  workstreamId: string | null;
  workstreamName: string | null;
}) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [intake] = useState(() => {
    // One routing call per dialog draft; a newer one or a cancel aborts it.
    const draftKey = crypto.randomUUID();
    return new Intake(
      async (options) =>
        (await rpc.call("route", {
          ...options,
          offerNewThread: true,
          draftKey,
        })) as RouteDecision,
      workstreamId,
      workstreamName,
      () => {
        void rpc.call("routeCancel", { draftKey }).catch(() => {
          // A cancel that can't reach the server only costs one wasted call.
        });
      },
    );
  });
  const [error, setError] = useState<string | null>(null);
  // Each send re-creates the alert so a repeated message is announced again.
  const [attempt, setAttempt] = useState(0);
  const intakeState = useSyncExternalStore(intake.subscribe, intake.snapshot);
  const routeError =
    intakeState.submitError ?? intakeState.error ?? intakeState.selectionError;
  // A failed create outlives the preview retry that clears the route error.
  const message = error ?? routeError;
  useEffect(() => () => intake.dispose(), [intake]);

  const submit = useCallback(
    async (request: NewThreadRequest) => {
      setError(null);
      setAttempt((n) => n + 1);
      const prompt = extractPrompt(request);
      let executing = false;
      try {
        const { decision, choice, intent } = await intake.forSubmit(prompt);
        executing = true;
        const result = await rpc.call("routeExecute", {
          decisionId: decision.id,
          prompt,
          choice,
          intent,
          execution: JSON.parse(
            JSON.stringify({
              providerId: request.providerId,
              model: request.model,
              reasoningLevel: request.reasoningLevel,
              permissionMode: request.permissionMode,
              serviceTier: request.serviceTier,
              executionInputSources: request.executionInputSources,
              input: request.input,
              ...(decision.outcome !== "continue"
                ? {
                    projectId: intake.snapshot().project.value,
                    environment: intake.snapshot().environment.value,
                  }
                : {}),
            }),
          ),
        });
        intake.completeSubmit();
        onClose();
        if (result.threadId) navigate.toThread(result.threadId);
      } catch (cause) {
        if (executing) intake.retry();
        setError(cause instanceof Error ? cause.message : String(cause));
        intake.completeSubmit();
        // Rejection tells the host to preserve attachments, mentions, and text.
        throw cause;
      }
    },
    [intake, navigate, onClose, rpc],
  );
  return (
    <IntakeContext.Provider value={intake}>
      {/* The intake banner owns placement and readiness; styles.css hides
          BB's own project and environment pickers inside `.ws-intake` and
          dims its submit button while the draft can't be sent yet. */}
      <div className="ws-intake" data-ready={intake.canSubmit()}>
        <Composer
          layout="document"
          draftKey={`workstreams-new:${workstreamId ?? "auto"}`}
          placeholder="What's the work?"
          onSubmit={submit}
        />
        <ContinueAction />
        <IntakeStatus intake={intake} />
        {message ? (
          <p
            key={attempt}
            role="alert"
            className="mt-2 px-3.5 text-xs text-destructive"
          >
            {message}
          </p>
        ) : null}
      </div>
    </IntakeContext.Provider>
  );
}
