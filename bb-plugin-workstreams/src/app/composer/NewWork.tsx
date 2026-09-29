/**
 * Workstreams ＋ New (SPEC §6): BB's own new-thread composer in a dialog.
 * Submitting routes on the server and previews the decision; Start (or ⏎)
 * accepts it. The thread spawns with the execution choices from the composer.
 */
import { useState } from "react";
import {
  experimental_NewThreadComposer,
  useBbNavigate,
  useRpc,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { RpcContract } from "../../server/contract.ts";
import type { RouteDecision } from "../../server/router.ts";

const textOf = (request: NewThreadRequest) =>
  request.input
    .map((part) =>
      "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("\n")
    .trim();

function describe(decision: RouteDecision): string {
  switch (decision.outcome) {
    case "continue":
      return `Continue “${decision.threadTitle}”`;
    case "new-thread":
      return `New thread in ${decision.workstream} · ${decision.placement.label}`;
    case "new-workstream":
      return `New workstream ${decision.name} · ${decision.placement.label}`;
    default:
      return "Not sure where this goes";
  }
}

export function NewWorkDialog({
  open,
  onClose,
  workstreamId = null,
}: {
  open: boolean;
  onClose: () => void;
  /** Start in this workstream without asking the router. */
  workstreamId?: string | null;
}) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [pending, setPending] = useState<{
    request: NewThreadRequest;
    prompt: string;
    decision: RouteDecision;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const Composer = experimental_NewThreadComposer;

  const close = () => {
    setPending(null);
    setError(null);
    onClose();
  };
  const preview = async (request: NewThreadRequest) => {
    setError(null);
    const prompt = textOf(request);
    try {
      const decision = await rpc.call("route", {
        prompt,
        pickedProjectId: request.projectId,
        workstreamId,
      });
      setPending({ request, prompt, decision: decision as RouteDecision });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // Keeps the draft: the composer restores it when onSubmit rejects.
      throw cause;
    }
  };
  const accept = async (
    choice?: { threadId: string } | { sectionId: string },
  ) => {
    if (!pending) return;
    setBusy(true);
    try {
      const { request } = pending;
      const result = await rpc.call("routeExecute", {
        decisionId: pending.decision.id,
        prompt: pending.prompt,
        choice: choice ?? null,
        // RPC input must be JSON, so drop undefined fields.
        execution: JSON.parse(
          JSON.stringify({
            providerId: request.providerId,
            model: request.model,
            reasoningLevel: request.reasoningLevel,
            permissionMode: request.permissionMode,
            ...(request.serviceTier
              ? { serviceTier: request.serviceTier }
              : {}),
            executionInputSources: request.executionInputSources,
            input: request.input,
          }),
        ) as Record<string, unknown>,
      });
      close();
      if (result.threadId) navigate.toThread(result.threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New work</DialogTitle>
        </DialogHeader>
        {pending ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (pending.decision.outcome !== "unsure") void accept();
            }}
          >
            <p className="text-sm">
              <span aria-hidden="true">✦ </span>
              {describe(pending.decision)}
            </p>
            {pending.decision.reason ? (
              <p className="text-xs text-muted-foreground">
                {pending.decision.reason}
              </p>
            ) : null}
            {pending.decision.outcome === "unsure" ? (
              <div className="flex flex-wrap gap-2">
                {pending.decision.candidates.map((c) => (
                  <Button
                    key={c.kind === "thread" ? c.threadId : c.sectionId}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void accept(
                        c.kind === "thread"
                          ? { threadId: c.threadId }
                          : { sectionId: c.sectionId },
                      )
                    }
                  >
                    {c.kind === "thread" ? c.title : c.name}
                  </Button>
                ))}
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPending(null)}
              >
                Back
              </Button>
              {pending.decision.outcome !== "unsure" ? (
                <Button type="submit" size="sm" disabled={busy} autoFocus>
                  {pending.decision.outcome === "continue"
                    ? "Send there"
                    : "Start"}{" "}
                  ⏎
                </Button>
              ) : null}
            </div>
          </form>
        ) : (
          <div className="min-h-40">
            <Composer
              draftKey="workstreams-new"
              placeholder="What's the work? Workstreams will suggest where it goes."
              onSubmit={preview}
            />
            {error ? (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
