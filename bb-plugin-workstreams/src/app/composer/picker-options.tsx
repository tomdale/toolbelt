/**
 * The searchable option lists behind New work's two pickers, shared by every
 * surface that offers them: the desktop popovers (`WorkstreamPicker`) and the
 * phone route sheet (`RoutePicker`). The rules — which entries appear, how a
 * query matches, what picking one does to the `NewWork` model — live here once;
 * the surfaces differ only in `variant`, which sets sizing.
 *
 * Product/Feature identity and Workstream placement stay independent:
 * - Identity says what the task concerns in the Catalog.
 * - Placement says where the thread is filed in the sidebar.
 * Choosing one never erases or forces the other. Searching matches full
 * ancestry paths and aliases.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import { corpusLabel } from "../../domain/corpus-label.ts";
import type { CorpusEntity } from "../../domain/corpus.ts";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { WorkstreamIcon } from "../WorkstreamIcon.tsx";
import { WorkstreamName } from "../WorkstreamName.tsx";
import { NO_WORKSTREAM_ICON, TAG_ICON } from "../workstream-icon.ts";
import { compareGroupNames } from "../../domain/group-name-order.ts";
import { useServerState } from "../useWorkstreams.ts";
import { type NewWork, type NewWorkState } from "./new-work.ts";

const NONE = "__none__";
const CREATE = "__create__";
const AUTOMATIC = "__automatic__";
/** A `Command` value no item has, so a list opens with nothing highlighted. */
const IDLE = "__idle__";

/**
 * BB's option-trigger classes, so a chip lines up with the pickers beside it
 * in BB's row. It is not `shrink-0` as BB's project chip is: when the row is
 * short the label ellipsizes, so nothing in the chip paints over a sibling.
 */
export const CHIP_CLASS =
  "h-8 w-fit max-w-full min-w-0 shrink items-center justify-start gap-1 px-1 text-xs leading-tight border-none bg-transparent shadow-none text-muted-foreground hover:text-muted-foreground";

/**
 * Where a list is shown. A `popover` is the floating panel beside a desktop
 * chip; a `sheet` is the phone drawer, whose list fills the sheet and whose
 * rows and search field are sized for a finger (rows 44px and the search at
 * `--text-base`, 16px, which stops iOS zooming the page on focus).
 */
export type OptionsVariant = "popover" | "sheet";

const VARIANT_CLASSES = {
  popover: {
    item: "items-start py-[0.3125rem] text-xs max-md:py-2",
    name: "text-xs font-medium",
    input: "h-8 text-xs",
    list: "max-h-72",
    note: "",
  },
  sheet: {
    item: "items-start py-2 text-sm pointer-coarse:min-h-11",
    name: "text-sm font-medium",
    input: "h-11 text-base",
    list: "min-h-0 max-h-none flex-1 overscroll-contain",
    note: "whitespace-normal",
  },
} as const;

/**
 * A chip's label. It ellipsizes as the row gets short, but an ellipsis needs
 * room: with only a few pixels left the browser draws a sliver of a letter.
 * Once less than 1.75em of a truncated label remains it is hidden (the box
 * keeps its size, so hiding it can't change the layout that decided to).
 */
export function ChipLabel({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [tiny, setTiny] = useState(false);
  useLayoutEffect(() => {
    const label = ref.current;
    if (!label || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const em = parseFloat(getComputedStyle(label).fontSize) || 12;
      setTiny(
        label.scrollWidth > label.clientWidth && label.clientWidth < 1.75 * em,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(label);
    return () => observer.disconnect();
  }, [children]);
  return (
    <span
      ref={ref}
      data-ws-label-tiny={tiny || undefined}
      className="min-w-0 truncate"
    >
      {children}
    </span>
  );
}

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
    if (parent.aliases.some((a) => a.toLowerCase().includes(needle)))
      return true;
    current = parent.parentId;
  }
  return false;
}

/**
 * The Catalog's entities, fetched each time `enabled` turns on (a picker
 * opening) so the list reflects products and features added since.
 */
export function useCatalogEntities(enabled: boolean): CorpusEntity[] {
  const rpc = useRpc<RpcContract>();
  const [entities, setEntities] = useState<CorpusEntity[]>([]);
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, rpc]);
  return entities;
}

/** The Product or feature field's value as the pickers state it. */
export function identityValue(state: NewWorkState): string {
  return state.identity ? state.identity.label : "Automatic";
}

export interface OptionsProps {
  newWork: NewWork;
  /** The Catalog, empty until `useCatalogEntities` has loaded it. */
  entities: readonly CorpusEntity[];
  query: string;
  onQueryChange: (query: string) => void;
  /** Runs after a choice has been applied, so the surface can close. */
  onDone: () => void;
  variant?: OptionsVariant;
}

/** The Product or feature list: Automatic, the Catalog, a new proposal, Unresolved. */
export function IdentityOptions({
  newWork,
  entities,
  query,
  onQueryChange,
  onDone,
  variant = "popover",
}: OptionsProps) {
  const state = useSyncExternalStore(newWork.subscribe, newWork.snapshot);
  const styles = VARIANT_CLASSES[variant];
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
  const isManual = state.identity?.provenance === "manual";
  const isUnresolved =
    isManual &&
    state.identity?.entityId === null &&
    state.identity?.proposal === null;

  return (
    <Command
      label="Search products and features"
      shouldFilter={false}
      defaultValue={
        variant === "sheet"
          ? IDLE
          : state.identity?.entityId
            ? `identity:${state.identity.entityId}`
            : isManual
              ? NONE
              : AUTOMATIC
      }
      className="min-h-0"
    >
      <CommandInput
        aria-label="Search products and features"
        placeholder="Find a product or feature"
        value={query}
        onValueChange={onQueryChange}
        className={styles.input}
      />
      <CommandList className={styles.list}>
        <CommandGroup>
          <CommandItem
            value={AUTOMATIC}
            aria-current={!isManual ? "true" : undefined}
            onSelect={() => {
              newWork.selectAutomaticIdentity();
              onDone();
            }}
            className={styles.item}
          >
            <span className="ws-spark" aria-hidden>
              ✦
            </span>
            <span className="min-w-0 flex-1 truncate">
              Automatic
              <span
                className={cn(
                  "block font-normal text-muted-foreground",
                  styles.note,
                )}
              >
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
              const isSelected =
                isManual && state.identity?.entityId === entity.id;
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
                    onDone();
                  }}
                  className={styles.item}
                >
                  <Icon
                    name={TAG_ICON}
                    className="size-4 text-muted-foreground shrink-0 mt-0.5"
                    aria-hidden
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={cn("truncate", styles.name)}>
                      {fullLabel}
                    </span>
                    <Description text={entity.description} />
                    {entity.aliases.length > 0 && (
                      <span className="line-clamp-1 text-2xs text-muted-foreground/80">
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
                onDone();
              }}
              className={styles.item}
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
            aria-current={isUnresolved ? "true" : undefined}
            onSelect={() => {
              newWork.selectIdentity(null);
              onDone();
            }}
            className={styles.item}
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
                isUnresolved ? "opacity-100" : "opacity-0",
              )}
              aria-hidden
            />
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
