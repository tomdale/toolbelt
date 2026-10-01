/**
 * The New work dialog: BB's own new-thread composer with a workstream field
 * beside its project picker, and a suggested home under it once the draft
 * has been classified.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
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
import { useHostPickerRow } from "./host-picker-row.ts";
import { NewWork as NewWorkModel, NewWorkContext } from "./new-work.ts";
import { useDebugMode } from "../debug/debug.ts";
import { NewWorkDebug } from "./NewWorkDebug.tsx";
import { SuggestionRow } from "./Suggestion.tsx";
import { WorkstreamPicker } from "./WorkstreamPicker.tsx";

export function NewWorkDialog({
  open,
  onClose,
  workstreamId = null,
  workstreamName = null,
}: {
  open: boolean;
  onClose: () => void;
  /** Preselects this workstream, as a workstream's ＋ does. */
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
  const [newWork] = useState(() => {
    // Routing calls for one dialog share a key, so a newer one, or a cancel,
    // aborts the model call in flight.
    const draftKey = crypto.randomUUID();
    return new NewWorkModel(
      {
        route: async (prompt, selectedWorkstreamId) =>
          (await rpc.call("route", {
            prompt,
            selectedWorkstreamId,
            suggest: true,
            draftKey,
          })) as RouteDecision,
        cancelRoute: () => {
          void rpc.call("routeCancel", { draftKey }).catch(() => {
            // A cancel that can't reach the server only costs one wasted call.
          });
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
        startThread: (sectionId, request) =>
          rpc.call("startThread", {
            sectionId,
            // The server forwards only the fields spawn takes.
            execution: JSON.parse(JSON.stringify(request)) as NewThreadRequest &
              Record<string, unknown>,
          }),
        sendToThread: async (threadId, input, traceId) => {
          await rpc.call("sendToThread", {
            threadId,
            input: JSON.parse(JSON.stringify(input)) as unknown[],
            traceId,
          });
        },
      },
      workstreamId
        ? { id: workstreamId, name: workstreamName ?? workstreamId }
        : null,
    );
  });
  useEffect(() => () => newWork.dispose(), [newWork]);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const pickerRow = useHostPickerRow(root);
  const debug = useDebugMode();

  const submit = useCallback(
    async (request: NewThreadRequest) => {
      try {
        const result = await newWork.submit(request);
        onClose();
        if (result.kind === "started") navigate.toThread(result.threadId);
        else
          toast.success(`Sent to ${result.title}`, {
            action: {
              label: "Open",
              onClick: () => navigate.toThread(result.threadId),
            },
          });
      } catch (cause) {
        newWork.reportError(cause);
        // Rejecting tells BB to keep the draft, attachments and mentions.
        throw cause;
      }
    },
    [navigate, newWork, onClose],
  );
  const picker = <WorkstreamPicker newWork={newWork} />;
  return (
    <NewWorkContext.Provider value={newWork}>
      <div ref={setRoot} className="ws-new-work">
        <Composer
          layout="document"
          draftKey={`workstreams-new:${workstreamId ?? "auto"}`}
          onSubmit={submit}
        />
        {pickerRow ? (
          createPortal(picker, pickerRow)
        ) : (
          <div className="flex px-3.5">{picker}</div>
        )}
        <SuggestionRow newWork={newWork} />
        {debug ? <NewWorkDebug newWork={newWork} /> : null}
      </div>
    </NewWorkContext.Provider>
  );
}
