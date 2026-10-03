/**
 * New work's workstream field, built to sit beside BB's project and
 * environment pickers and match them: a ghost trigger and a searchable
 * popover list. The field starts Automatic: the classifier's destination
 * shows in the magic tint, and any manual pick — including No workstream —
 * pins it back to the ordinary muted treatment. Searching for a name no
 * workstream has offers to create it.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import { corpusLabel } from "../../domain/corpus-label.ts";
import type { CorpusEntity } from "../../domain/corpus.ts";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Icon } from "@/components/ui/icon";
import { WorkstreamIcon } from "../WorkstreamIcon.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { WorkstreamName } from "../WorkstreamName.tsx";
import { NO_WORKSTREAM_ICON, WORKSTREAM_ICON } from "../workstream-icon.ts";
import { compareGroupNames } from "../../domain/group-name-order.ts";
import { useServerState } from "../useWorkstreams.ts";
import { pickerDisplay, type NewWork } from "./new-work.ts";

/** BB's option-trigger classes, so the field lines up with the pickers beside it. */
const TRIGGER_CLASS =
  "h-8 w-fit max-w-full min-w-0 shrink-0 items-center justify-start gap-1 px-1 text-xs leading-tight border-none bg-transparent shadow-none text-muted-foreground hover:text-muted-foreground";
const ITEM_CLASS = "items-start py-[0.3125rem] text-xs max-md:py-2";

/** A one-or-two-line summary under an item's name, like BB's environment picker. */
function Description({ text }: { text: string | null | undefined }) {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return (
    <span className="line-clamp-2 text-xs font-normal text-muted-foreground">
      {trimmed}
    </span>
  );
}
const NONE = "__none__";
const CREATE = "__create__";
const AUTOMATIC = "__automatic__";

export function WorkstreamPicker({ newWork }: { newWork: NewWork }) {
  const state = useSyncExternalStore(newWork.subscribe, newWork.snapshot);
  const selected = state.workstream;
  const display = pickerDisplay(state);
  const { server } = useServerState();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rpc = useRpc<RpcContract>();
  const [entities, setEntities] = useState<CorpusEntity[]>([]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    rpc
      .call("corpus", null)
      .then((result) => {
        if (live) setEntities(result.entities);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, rpc]);
  const workstreams = useMemo(
    () =>
      Object.values(server.workstreams).sort((a, b) =>
        compareGroupNames(a.name, b.name),
      ),
    [server.workstreams],
  );
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? workstreams.filter((w) =>
        [w.name, w.description ?? ""].some((text) =>
          text.toLowerCase().includes(needle),
        ),
      )
    : workstreams;
  const inactive = entities
    .filter(
      (e) =>
        !workstreams.some((w) => w.name === e.name) &&
        (!needle ||
          [e.name, e.description, ...e.aliases].some((n) =>
            n.toLowerCase().includes(needle),
          )),
    )
    .sort((a, b) =>
      compareGroupNames(
        corpusLabel(a.id, entities),
        corpusLabel(b.id, entities),
      ),
    );
  const exact =
    workstreams.some((w) => w.name.toLowerCase() === needle) ||
    entities.some((e) => e.name.toLowerCase() === needle);
  // A rename elsewhere shows here; a just-created workstream may not be
  // listed yet.
  const label = selected
    ? (server.workstreams[selected.id]?.name ?? selected.name)
    : display.label;
  const openChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const pick = (
    choice: { id: string; name: string; subjectId?: string } | null,
  ) => {
    newWork.selectWorkstream(choice);
    openChange(false);
  };
  const automaticTitle = display.creating
    ? `New workstream “${label}” — created when you start`
    : display.auto
      ? (display.reason ?? "The classifier fills this as you type")
      : null;
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
        className={TRIGGER_CLASS}
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
          <span className="min-w-0 truncate">{label}</span>
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
        <Command
          label="Search workstreams"
          shouldFilter={false}
          defaultValue={selected?.id ?? NONE}
          className="min-h-0"
        >
          <CommandInput
            aria-label="Search workstreams"
            placeholder="Find or create a workstream"
            value={query}
            onValueChange={setQuery}
            className="h-8 text-xs"
          />
          <CommandList className="max-h-72">
            <CommandGroup>
              <CommandItem
                value={AUTOMATIC}
                aria-current={!state.pinned ? "true" : undefined}
                onSelect={() => {
                  newWork.selectAutomatic();
                  openChange(false);
                }}
                className={ITEM_CLASS}
              >
                <span className="ws-spark" aria-hidden>
                  ✦
                </span>
                <span className="min-w-0 flex-1 truncate">
                  Automatic
                  <span className="block font-normal text-muted-foreground">
                    The classifier files new work
                  </span>
                </span>
                <Icon
                  name="Check"
                  className={cn(
                    "ml-auto size-4",
                    !state.pinned ? "opacity-100" : "opacity-0",
                  )}
                  aria-hidden
                />
              </CommandItem>
            </CommandGroup>
            {visible.length ? (
              <CommandGroup heading="Workstream">
                {visible.map((w) => (
                  <CommandItem
                    key={w.sectionId}
                    value={w.sectionId}
                    aria-current={
                      w.sectionId === selected?.id ? "true" : undefined
                    }
                    onSelect={() => pick({ id: w.sectionId, name: w.name })}
                    className={ITEM_CLASS}
                  >
                    <WorkstreamIcon className="size-4" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <WorkstreamName
                        name={w.name}
                        className="text-xs font-medium"
                      />
                      <Description text={w.description} />
                    </span>
                    <Icon
                      name="Check"
                      className={cn(
                        "ml-auto size-4",
                        w.sectionId === selected?.id
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                      aria-hidden
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {inactive.length ? (
              <CommandGroup heading="Known products and features">
                {inactive.map((entity) => (
                  <CommandItem
                    key={`entity:${entity.id}`}
                    value={`entity:${entity.id}`}
                    onSelect={() => {
                      void rpc
                        .call("corpusSelect", { entityId: entity.id })
                        .then((result) =>
                          pick({
                            id: result.sectionId,
                            name: result.name,
                            subjectId: entity.id,
                          }),
                        )
                        .catch((error) => newWork.reportError(error));
                    }}
                    className={ITEM_CLASS}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-medium">
                        {corpusLabel(entity.id, entities)}
                      </span>
                      <Description text={entity.description} />
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {visible.length ? <CommandSeparator /> : null}
            <CommandGroup>
              {needle && !exact ? (
                <CommandItem
                  value={CREATE}
                  onSelect={() => {
                    void newWork.createWorkstream(query);
                    openChange(false);
                  }}
                  className={ITEM_CLASS}
                >
                  <Icon
                    name="Plus"
                    className="size-4 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">
                    New workstream “{query.trim()}”
                  </span>
                </CommandItem>
              ) : null}
              <CommandItem
                value={NONE}
                aria-current={selected === null ? "true" : undefined}
                onSelect={() => pick(null)}
                className={ITEM_CLASS}
              >
                <Icon
                  name={NO_WORKSTREAM_ICON}
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
                No workstream
                <Icon
                  name="Check"
                  className={cn(
                    "ml-auto size-4",
                    selected === null ? "opacity-100" : "opacity-0",
                  )}
                  aria-hidden
                />
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
