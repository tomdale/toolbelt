/** Workstreams intake keeps the draft and its destination in one composer. */
import { useEffect, useState, useSyncExternalStore } from "react";
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
  const [intake] = useState(
    () =>
      new Intake(
        async (options) => (await rpc.call("route", options)) as RouteDecision,
        workstreamId,
        workstreamName,
      ),
  );
  const [error, setError] = useState<string | null>(null);
  // Each send re-creates the alert so a repeated message is announced again.
  const [attempt, setAttempt] = useState(0);
  const settings = useSyncExternalStore(
    intake.subscribe,
    () => intake.snapshot().settings,
  );
  const routeError = useSyncExternalStore(
    intake.subscribe,
    () => intake.snapshot().error,
  );
  // A failed create outlives the preview retry that clears the route error.
  const message = error ?? routeError;
  useEffect(() => () => intake.dispose(), [intake]);

  const submit = async (request: NewThreadRequest) => {
    setError(null);
    setAttempt((n) => n + 1);
    const prompt = request.input
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n")
      .trim();
    let executing = false;
    try {
      const { decision, choice } = await intake.forSubmit(prompt);
      executing = true;
      const result = await rpc.call("routeExecute", {
        decisionId: decision.id,
        prompt,
        choice,
        execution: JSON.parse(
          JSON.stringify({
            providerId: request.providerId,
            model: request.model,
            reasoningLevel: request.reasoningLevel,
            permissionMode: request.permissionMode,
            serviceTier: request.serviceTier,
            executionInputSources: request.executionInputSources,
            input: request.input,
            ...(intake.customizePlacement &&
            (decision.outcome === "new-thread" ||
              decision.outcome === "new-workstream") &&
            request.projectId === decision.placement.projectId
              ? {
                  projectId: request.projectId,
                  environment: request.environment,
                }
              : {}),
          }),
        ),
      });
      onClose();
      if (result.threadId) navigate.toThread(result.threadId);
    } catch (cause) {
      if (executing) {
        intake.retry();
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      // Rejection tells the host to preserve attachments, mentions, and text.
      throw cause;
    }
  };

  return (
    <IntakeContext.Provider value={intake}>
      <div className="ws-intake" data-settings={settings ? "open" : "closed"}>
        <Composer
          layout="document"
          draftKey={`workstreams-new:${workstreamId ?? "auto"}`}
          placeholder="What's the work?"
          onSubmit={submit}
        />
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
