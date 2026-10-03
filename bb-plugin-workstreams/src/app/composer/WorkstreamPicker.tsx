/**
 * Independent Product/Feature identity and Workstream placement controls for New work,
 * built to sit beside BB's project and environment pickers: ghost triggers with searchable
 * popover commands.
 *
 * Identity and Workstream destinations are independent:
 * - Product/Feature identity represents what the task concerns in the Catalog.
 * - Workstream placement represents where the thread is filed in the sidebar.
 * Changing placement does not erase identity; choosing an identity does not force a move.
 *
 * The lists live in `picker-options.tsx`, shared with the phone's route sheet.
 * On a phone-sized viewport the two chips give way to one route chip
 * (`RoutePicker.tsx`); only one variant is ever in the DOM. Either way the
 * chips share BB's picker row with BB's own chips, so they shrink: a label
 * ellipsizes before anything paints over a neighbor (`route-picker.css`).
 */
import { useState, useSyncExternalStore } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Button } from "@/components/ui/button";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { NO_WORKSTREAM_ICON, WORKSTREAM_ICON } from "../workstream-icon.ts";
import { identityDisplay, type NewWork } from "./new-work.ts";
import {
  CHIP_CLASS,
  ChipLabel,
  IdentityOptions,
  WorkstreamOptions,
  identityValue,
  useCatalogEntities,
  useWorkstreamView,
  workstreamNote,
} from "./picker-options.tsx";
import { RoutePicker } from "./RoutePicker.tsx";
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
            <Icon name="Tag" className="size-3.5 shrink-0" aria-hidden />
          )}
          <ChipLabel>
            {state.identity ? state.identity.label : `Concerning: ${label}`}
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

export function WorkstreamControl({ newWork }: { newWork: NewWork }) {
  const state = useSyncExternalStore(newWork.subscribe, newWork.snapshot);
  const { display, label, selected } = useWorkstreamView(state);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const entities = useCatalogEntities(open);

  const openChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const automaticTitle = workstreamNote(display, label);

  const trigger = (
    <PopoverTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Workstream: ${label}`}
        data-ws-workstream-control=""
        data-ws-auto={display.auto || undefined}
        data-ws-destination={display.destination || undefined}
        data-ws-stale={(display.auto && state.classifying) || undefined}
        className={CHIP_CLASS}
      >
        <span className="contents">
          {display.auto ? (
            <span className="ws-spark" aria-hidden>
              ✦
            </span>
          ) : (
            <Icon
              name={selected ? WORKSTREAM_ICON : NO_WORKSTREAM_ICON}
              className="size-3.5 shrink-0"
              aria-hidden
            />
          )}
          <ChipLabel>{label}</ChipLabel>
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
      {automaticTitle ? (
        <Tooltip.Provider delayDuration={150}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>{trigger}</Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                side="top"
                sideOffset={5}
                collisionPadding={12}
                className="z-50 max-w-72 rounded-md border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md"
              >
                {automaticTitle}
                <Tooltip.Arrow className="fill-popover" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
      ) : (
        trigger
      )}
      <PopoverContent
        align="start"
        aria-label="Workstream"
        mobileTitle="Workstream"
        className="flex max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))] w-60 flex-col overflow-hidden p-0 max-md:min-h-0 max-md:flex-1"
      >
        <WorkstreamOptions
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
 * The field New work adds to BB's picker row: the two chips on a wide screen,
 * the single route chip on a phone.
 */
export function WorkstreamPicker({ newWork }: { newWork: NewWork }) {
  const compact = useIsCompactViewport();
  return (
    <div
      className="flex items-center gap-0.5 max-w-full min-w-0"
      data-ws-composer-controls=""
      data-ws-variant={compact ? "route" : "split"}
    >
      {compact ? (
        <RoutePicker newWork={newWork} />
      ) : (
        <>
          <IdentityControl newWork={newWork} />
          <span
            className="text-muted-foreground/30 text-xs select-none mx-0.5"
            aria-hidden
          >
            ·
          </span>
          <WorkstreamControl newWork={newWork} />
        </>
      )}
    </div>
  );
}
