/**
 * New work's workstream field, built to sit beside BB's project and
 * environment pickers and match them: a muted ghost trigger and a searchable
 * popover list. Searching for a name no workstream has offers to create it.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { WorkstreamName } from "../WorkstreamName.tsx";
import { applyOrder } from "../../domain/order.ts";
import { useServerState } from "../useWorkstreams.ts";
import type { NewWork } from "./new-work.ts";

/** BB's option-trigger classes, so the field lines up with the pickers beside it. */
const TRIGGER_CLASS =
  "h-8 w-fit max-w-full min-w-0 shrink-0 items-center justify-start gap-1 px-1 text-xs leading-tight border-none bg-transparent shadow-none text-muted-foreground hover:text-muted-foreground";
const ITEM_CLASS = "py-[0.3125rem] text-xs max-md:py-2";
const NONE = "__none__";
const CREATE = "__create__";

export function WorkstreamPicker({ newWork }: { newWork: NewWork }) {
  const selected = useSyncExternalStore(
    newWork.subscribe,
    () => newWork.snapshot().workstream,
  );
  const { server } = useServerState();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const workstreams = useMemo(
    () =>
      applyOrder(
        Object.values(server.workstreams).sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
        server.order.workstreams,
        (w) => w.sectionId,
        "last",
      ),
    [server.workstreams, server.order.workstreams],
  );
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? workstreams.filter((w) => w.name.toLowerCase().includes(needle))
    : workstreams;
  const exact = workstreams.some((w) => w.name.toLowerCase() === needle);
  // A rename elsewhere shows here; a just-created workstream may not be
  // listed yet.
  const label = selected
    ? (server.workstreams[selected.id]?.name ?? selected.name)
    : "No workstream";
  const openChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const pick = (choice: { id: string; name: string } | null) => {
    newWork.selectWorkstream(choice);
    openChange(false);
  };
  return (
    <Popover open={open} onOpenChange={openChange} modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Workstream: ${label}`}
          data-ws-workstream-control=""
          className={TRIGGER_CLASS}
        >
          <span className="contents">
            <Icon
              name={selected ? "Layers" : "CircleDashed"}
              className="size-3.5 shrink-0"
              aria-hidden
            />
            <span className="min-w-0 truncate">{label}</span>
          </span>
          <Icon
            name="ChevronDown"
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </Button>
      </PopoverTrigger>
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
                    <Icon
                      name="Layers"
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                    <WorkstreamName
                      name={w.name}
                      className="min-w-0 flex-1 text-xs"
                    />
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
                  name="CircleDashed"
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
