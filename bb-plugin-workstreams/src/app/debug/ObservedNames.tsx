import { useEffect, useState } from "react";
import {
  useRpc,
  useRealtime,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useDebugMode } from "./debug.ts";
import type { RpcContract } from "../../server/contract.ts";
import type { ObservedNames } from "../../domain/name-observations.ts";

export function ObservedNamesHeader({
  threadId,
}: PluginThreadHeaderActionProps) {
  return useDebugMode() ? (
    <NamesPopover key={threadId} threadId={threadId} />
  ) : null;
}

function NamesPopover({ threadId }: { threadId: string }) {
  const rpc = useRpc<RpcContract>();
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<ObservedNames | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useRealtime("changed", () => setGeneration((value) => value + 1));
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    rpc.call("observedNames", { threadId }).then(
      (result) => {
        if (live) setNames(result);
      },
      (cause: unknown) => {
        if (live) setError(String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [open, rpc, threadId, generation]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          aria-label="Observed product and feature names"
        >
          Observed names
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-96 w-96 overflow-y-auto text-xs"
      >
        <h3 className="font-semibold">Products and features observed</h3>
        <p className="mt-1 text-muted-foreground">
          Accumulated from this thread’s Full analysis calls. Observations are
          not topic assignments. Counts are analysis runs, not mentions.
        </p>
        {error ? (
          <p role="alert" className="mt-2 text-destructive">
            {error}
          </p>
        ) : null}
        {!names && !error ? (
          <p className="mt-2">Loading observations…</p>
        ) : null}
        {names ? (
          <>
            <h4 className="mt-3 font-medium">Products</h4>
            {names.products.length ? (
              <ul className="mt-1 space-y-1">
                {names.products.map((product) => (
                  <li
                    key={product.name}
                    title={`First seen ${new Date(product.firstSeenAt).toLocaleString()}; last seen ${new Date(product.lastSeenAt).toLocaleString()}`}
                  >
                    <span>{product.name}</span>{" "}
                    <span className="text-muted-foreground">
                      · {product.runs} run{product.runs === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No products observed yet.</p>
            )}
            <h4 className="mt-3 font-medium">Features</h4>
            {names.features.length ? (
              <ul className="mt-1 space-y-1">
                {names.features.map((feature) => (
                  <li
                    key={JSON.stringify([feature.name, feature.product])}
                    title={`First seen ${new Date(feature.firstSeenAt).toLocaleString()}; last seen ${new Date(feature.lastSeenAt).toLocaleString()}`}
                  >
                    <span>{feature.name}</span>{" "}
                    <span className="text-muted-foreground">
                      · {feature.product ?? "Unknown product"} · {feature.runs}{" "}
                      run{feature.runs === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No features observed yet.</p>
            )}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
