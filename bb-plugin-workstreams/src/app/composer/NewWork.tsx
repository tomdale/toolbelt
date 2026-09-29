/** Workstreams intake keeps the draft and its destination in one composer. */
import { useEffect, useState } from "react";
import {
  experimental_NewThreadComposer as Composer,
  useBbNavigate,
  useRpc,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { RpcContract } from "../../server/contract.ts";
import type { RouteDecision } from "../../server/router.ts";
import { Intake, IntakeContext } from "./intake.ts";

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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New work</DialogTitle>
        </DialogHeader>
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
  const [settings, setSettings] = useState(false);
  useEffect(() => () => intake.dispose(), [intake]);

  const submit = async (request: NewThreadRequest) => {
    setError(null);
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
      <div
        className="ws-intake min-h-40"
        data-settings={settings ? "open" : "closed"}
      >
        <Composer
          draftKey={`workstreams-new:${workstreamId ?? "auto"}`}
          placeholder="What's the work?"
          onSubmit={submit}
        />
        {error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="mt-2 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={settings}
          onClick={() => {
            intake.customizePlacement = true;
            setSettings(!settings);
          }}
        >
          {settings ? "Hide settings" : "Settings"}
        </button>
      </div>
    </IntakeContext.Provider>
  );
}
