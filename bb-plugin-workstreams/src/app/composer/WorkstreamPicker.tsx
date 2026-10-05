/**
 * Product/Feature identity control for New work, built to sit beside BB's
 * project and environment pickers: a ghost trigger with searchable popover
 * command.
 *
 * New-work UI ONLY exposes Product/Feature identity selection, auto
 * suggestion, and manual Unresolved. Workstreams are always derived
 * automatically from active task identities by the coordinator.
 */
import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TAG_ICON } from "../workstream-icon.ts";
import { identityDisplay, type NewWork } from "./new-work.ts";
import {
  CHIP_CLASS,
  ChipLabel,
  IdentityOptions,
  identityValue,
  useCatalogEntities,
} from "./picker-options.tsx";
import "./route-picker.css";

export { matchesEntity } from "./picker-options.tsx";

export function IdentityControl({ newWork }: { newWork: NewWork }) {
  const state = useSyncExternalStore(newWork.subscribe, newWork.snapshot);
  const display = identityDisplay(state);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const entities = useCatalogEntities(open);

  const openChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const label = identityValue(state);

  const trigger = (
    <PopoverTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Product or feature: ${label}`}
        data-ws-identity-control=""
        data-ws-auto={display.auto || undefined}
        className={CHIP_CLASS}
      >
        <span className="contents">
          {display.auto ? (
            <span className="ws-spark" aria-hidden>
              ✦
            </span>
          ) : (
            <Icon name={TAG_ICON} className="size-3.5 shrink-0" aria-hidden />
          )}
          <ChipLabel>
            {display.label}
          </ChipLabel>
        </span>
        <Icon
          name="ChevronDown"
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
      </Button>
    </PopoverTrigger>
  );

  return (
    <Popover open={open} onOpenChange={openChange} modal>
      {trigger}
      <PopoverContent
        align="start"
        aria-label="Product or feature"
        mobileTitle="Product or feature"
        className="flex max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))] w-64 flex-col overflow-hidden p-0 max-md:min-h-0 max-md:flex-1"
      >
        <IdentityOptions
          newWork={newWork}
          entities={entities}
          query={query}
          onQueryChange={setQuery}
          onDone={() => openChange(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The field New work adds to BB's picker row: the Product/Feature identity chip.
 */
export function WorkstreamPicker({ newWork }: { newWork: NewWork }) {
  return (
    <div
      className="flex items-center gap-0.5 max-w-full min-w-0"
      data-ws-composer-controls=""
    >
      <IdentityControl newWork={newWork} />
    </div>
  );
}
