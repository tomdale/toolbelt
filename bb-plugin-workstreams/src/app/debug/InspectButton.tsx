/**
 * The small inspect button Debug mode adds wherever Workstreams used a model
 * (SPEC §11.6). It renders nothing while Debug mode is off, and opens the
 * inspector pane for its target.
 */
import { useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useDebugMode, type InspectTarget } from "./debug.ts";
import { TraceInspector } from "./Inspector.tsx";

export function InspectButton({
  target,
  title,
  label = "Inspect model call",
  className,
}: {
  target: InspectTarget;
  /** The pane's heading: what the calls explain. */
  title: string;
  /** Accessible name and tooltip. */
  label?: string;
  className?: string;
}) {
  const debug = useDebugMode();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!debug) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-workstreams-inspect=""
        // Rows and banners around it navigate, drag, or toggle on these.
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          "inline-flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent p-0 text-inherit opacity-55 hover:bg-current/10 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring aria-expanded:opacity-100",
          className,
        )}
      >
        <Icon name="Bug" aria-hidden className="size-3.5" />
      </button>
      <TraceInspector
        open={open}
        onOpenChange={setOpen}
        target={target}
        title={title}
        returnFocus={() => button.current?.focus()}
      />
    </>
  );
}
