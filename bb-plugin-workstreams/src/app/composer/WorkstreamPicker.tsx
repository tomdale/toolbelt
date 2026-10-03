/**
 * Independent Product/Feature identity and Workstream placement controls for New work,
 * built to sit beside BB's project and environment pickers: ghost triggers with searchable
 * popover commands.
 *
 * Identity and Workstream destinations are independent:
 * - Product/Feature identity represents what the task concerns in the Catalog.
 * - Workstream placement represents where the thread is filed in the sidebar.
 * Changing placement does not erase identity; choosing an identity does not force a move.
 * Searching matches full ancestry paths and aliases.
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
import {
  identityDisplay,
  pickerDisplay,
  type NewWork,
} from "./new-work.ts";

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

/** Matches search queries against entity name, full ancestry, aliases, and description. */
export function matchesEntity(
  entity: CorpusEntity,
  entities: readonly CorpusEntity[],
  query: string,
): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (entity.name.toLowerCase().includes(needle)) return true;
  if (entity.description?.toLowerCase().includes(needle)) return true;
  if (entity.aliases.some((a) => a.toLowerCase().includes(needle))) return true;

  let current: string | null = entity.parentId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = entities.find((e) => e.id === current);
    if (!parent) break;
    if (parent.name.toLowerCase().includes(needle)) return true;
    if (parent.aliases.some((a) => a.toLowerCase().includes(needle))) return true;
    current = parent.parentId;
  }
  return false;
}

export function IdentityControl({ newWork }: { newWork: NewWork }) {
  const state = useSyncExternalStore(newWork.subscribe, newWork.snapshot);
  const display = identityDisplay(state);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rpc = useRpc<RpcContract>();
  const [entities, setEntities] = useState<CorpusEntity[]>([]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    rpc
      .call("catalog", null)
      .then((result) => {
        if (live) setEntities(result.entities);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, rpc]);

  const needle = query.trim().toLowerCase();
  const visibleEntities = useMemo(() => {
    return entities
      .filter((e) => matchesEntity(e, entities, needle))
      .sort((a, b) =>
        compareGroupNames(
          corpusLabel(a.id, entities),
          corpusLabel(b.id, entities),
        ),
      );
  }, [entities, needle]);

  const exact = entities.some((e) => e.name.toLowerCase() === needle);

  const openChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const isManual = state.identity?.provenance === "manual";
  const label = state.identity ? state.identity.label : display.auto ? "Automatic" : "Unresolved";

  const trigger = (
    <PopoverTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Product or feature: ${label}`}
        data-ws-identity-control=""
        data-ws-auto={display.auto || undefined}
        className={TRIGGER_CLASS}
      >
        <span className="contents">
          {display.auto ? (
            <span className="ws-spark" aria-hidden>
              ✦
            </span>
          ) : (
            <Icon name="Tag" className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 truncate">
            {state.identity ? state.identity.label : `Concerning: ${label}`}
          </span>
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
        <Command
          label="Search products and features"
          shouldFilter={false}
          defaultValue={state.identity?.entityId ?? (isManual ? NONE : AUTOMATIC)}
          className="min-h-0"
        >
          <CommandInput
            aria-label="Search products and features"
            placeholder="Find a product or feature"
            value={query}
            onValueChange={setQuery}
            className="h-8 text-xs"
          />
          <CommandList className="max-h-72">
            <CommandGroup>
              <CommandItem
                value={AUTOMATIC}
                aria-current={!isManual ? "true" : undefined}
                onSelect={() => {
                  newWork.selectAutomaticIdentity();
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
                    The classifier identifies products and features
                  </span>
                </span>
                <Icon
                  name="Check"
                  className={cn(
                    "ml-auto size-4",
                    !isManual ? "opacity-100" : "opacity-0",
                  )}
                  aria-hidden
                />
              </CommandItem>
            </CommandGroup>
            {visibleEntities.length ? (
              <CommandGroup heading="Products and features">
                {visibleEntities.map((entity) => {
                  const fullLabel = corpusLabel(entity.id, entities);
                  const isSelected = state.identity?.entityId === entity.id;
                  return (
                    <CommandItem
                      key={`identity:${entity.id}`}
                      value={`identity:${entity.id}`}
                      aria-current={isSelected ? "true" : undefined}
                      onSelect={() => {
                        newWork.selectIdentity({
                          entityId: entity.id,
                          label: fullLabel,
                        });
                        openChange(false);
                      }}
                      className={ITEM_CLASS}
                    >
                      <Icon
                        name="Tag"
                        className="size-4 text-muted-foreground shrink-0 mt-0.5"
                        aria-hidden
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate font-medium">{fullLabel}</span>
                        <Description text={entity.description} />
                        {entity.aliases.length > 0 && (
                          <span className="line-clamp-1 text-[10px] text-muted-foreground/80">
                            Aliases: {entity.aliases.join(", ")}
                          </span>
                        )}
                      </span>
                      <Icon
                        name="Check"
                        className={cn(
                          "ml-auto size-4 shrink-0",
                          isSelected ? "opacity-100" : "opacity-0",
                        )}
                        aria-hidden
                      />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
            {visibleEntities.length ? <CommandSeparator /> : null}
            <CommandGroup>
              {needle && !exact ? (
                <CommandItem
                  value={CREATE}
                  onSelect={() => {
                    newWork.selectIdentity({
                      proposal: { name: query.trim(), description: "" },
                      label: query.trim(),
                    });
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
                    New feature proposal “{query.trim()}”
                  </span>
                </CommandItem>
              ) : null}
              <CommandItem
                value={NONE}
                aria-current={state.identity === null && isManual ? "true" : undefined}
                onSelect={() => {
                  newWork.selectIdentity(null);
                  openChange(false);
                }}
                className={ITEM_CLASS}
              >
                <Icon
                  name="X"
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
                Unresolved
                <Icon
                  name="Check"
                  className={cn(
                    "ml-auto size-4",
                    state.identity === null && isManual
                      ? "opacity-100"
                      : "opacity-0",
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

export function WorkstreamControl({ newWork }: { newWork: NewWork }) {
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
      .call("catalog", null)
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

  const inactive = useMemo(() => {
    return entities
      .filter(
        (e) =>
          !workstreams.some((w) => w.name === e.name) &&
          matchesEntity(e, entities, needle),
      )
      .sort((a, b) =>
        compareGroupNames(
          corpusLabel(a.id, entities),
          corpusLabel(b.id, entities),
        ),
      );
  }, [entities, workstreams, needle]);

  const exact =
    workstreams.some((w) => w.name.toLowerCase() === needle) ||
    entities.some((e) => e.name.toLowerCase() === needle);

  const label = selected
    ? (server.workstreams[selected.id]?.name ?? selected.name)
    : display.label;

  const openChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const pick = (
    choice: { id: string; name: string } | null,
  ) => {
    newWork.selectWorkstream(choice);
    openChange(false);
  };

  const automaticTitle = display.creating
    ? `New workstream “${label}” — created when you start`
    : display.auto
      ? (display.reason ?? "The classifier files this as you type")
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
                      newWork.selectIdentity({
                        entityId: entity.id,
                        label: corpusLabel(entity.id, entities),
                      });
                      void rpc
                        .call("catalogResolve", { entityId: entity.id })
                        .then((result) => {
                          if (result.sectionId && result.name) {
                            pick({
                              id: result.sectionId,
                              name: result.name,
                            });
                          }
                        })
                        .catch((error) => newWork.reportError(error));
                      openChange(false);
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
                aria-current={selected === null && state.pinned ? "true" : undefined}
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
                    selected === null && state.pinned ? "opacity-100" : "opacity-0",
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

export function WorkstreamPicker({ newWork }: { newWork: NewWork }) {
  return (
    <div
      className="flex items-center gap-0.5 max-w-full min-w-0"
      data-ws-composer-controls=""
    >
      <IdentityControl newWork={newWork} />
      <span
        className="text-muted-foreground/30 text-xs select-none mx-0.5"
        aria-hidden
      >
        ·
      </span>
      <WorkstreamControl newWork={newWork} />
    </div>
  );
}
