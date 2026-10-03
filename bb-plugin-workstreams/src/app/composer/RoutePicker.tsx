/**
 * New work's two pickers as one control for phones.
 *
 * BB's picker row below the prompt box has room for its own project and
 * environment chips and little else on a phone, so the Product or feature and
 * Workstream chips are replaced by a single route chip at the row's start. It
 * shows where the thread will be filed, exactly as the Workstream chip does on
 * wider screens, and its accessible name states both values. It shrinks (the
 * label ellipsizes first, down to ✦ and the chevron) so BB's chips are never
 * pushed or overlapped.
 *
 * Tapping the chip opens one sheet — BB's shared bottom drawer, through the
 * plugin's Popover — with a tab for each picker. Each tab shows its current
 * value; the selected tab shows the same searchable list the desktop popover
 * does (`picker-options.tsx`), and picking an entry applies it and closes the
 * sheet. A touch screen has no tooltips, so the sheet states the classifier's
 * reason for an Automatic destination itself.
 */
import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { Button } from "@/components/ui/button";
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
  workstreamNotes,
} from "./picker-options.tsx";

type RouteTab = "workstream" | "identity";

const TABS: readonly { key: RouteTab; label: string }[] = [
  { key: "workstream", label: "Workstream" },
  { key: "identity", label: "Product or feature" },
];

const EMPTY_QUERIES: Record<RouteTab, string> = {
  workstream: "",
  identity: "",
};

export function RoutePicker({ newWork }: { newWork: NewWork }) {
  const state = useSyncExternalStore(newWork.subscribe, newWork.snapshot);
  const { display, label, selected } = useWorkstreamView(state);
  const identity = identityDisplay(state);
  const identityText = identityValue(state);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<RouteTab>("workstream");
  const [queries, setQueries] = useState(EMPTY_QUERIES);
  const entities = useCatalogEntities(open);
  const ids = useId();
  const tabRefs = useRef<Record<RouteTab, HTMLButtonElement | null>>({
    workstream: null,
    identity: null,
  });
  const panelId = `${ids}-panel`;
  const tabId = (key: RouteTab) => `${ids}-tab-${key}`;

  // The sheet is a persistent drawer, so its state outlives a close: each
  // opening starts on the Workstream tab with empty searches.
  const openChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setTab("workstream");
      setQueries(EMPTY_QUERIES);
    }
  };
  const close = () => openChange(false);

  const values: Record<RouteTab, { auto: boolean; text: string }> = {
    workstream: { auto: display.auto, text: label },
    identity: { auto: identity.auto, text: identityText },
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((t) => t.key === tab);
    let to: number;
    switch (event.key) {
      case "ArrowRight":
        to = (at + 1) % TABS.length;
        break;
      case "ArrowLeft":
        to = (at - 1 + TABS.length) % TABS.length;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = TABS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = TABS[to]!.key;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const notes = tab === "workstream" ? workstreamNotes(display, label) : [];

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Route: Workstream ${label}, Product or feature ${identityText}`}
          // The route chip is the phone's Workstream field, so it keeps that
          // field's markers: the magic tint, the classifying pulse and the
          // stylesheet's other hooks key on them.
          data-ws-route-control=""
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
      <PopoverContent
        align="start"
        aria-label="Route"
        mobileTitle="Route"
        className="ws-route-sheet flex min-h-0 flex-1 flex-col overflow-hidden p-0"
      >
        <div
          role="tablist"
          aria-label="Route"
          className="ws-route-tabs"
          onKeyDown={onTabKeyDown}
        >
          {TABS.map(({ key, label: tabLabel }) => {
            const selectedTab = key === tab;
            const value = values[key];
            return (
              <button
                key={key}
                ref={(node) => {
                  tabRefs.current[key] = node;
                }}
                type="button"
                role="tab"
                id={tabId(key)}
                aria-selected={selectedTab}
                aria-controls={selectedTab ? panelId : undefined}
                tabIndex={selectedTab ? 0 : -1}
                data-ws-route-tab={key}
                data-ws-auto={value.auto || undefined}
                className="ws-route-tab"
                onClick={() => setTab(key)}
              >
                <span className="ws-route-tab-label">{tabLabel}</span>
                <span className="ws-route-tab-value">
                  {value.auto ? (
                    <span className="ws-spark" aria-hidden>
                      ✦
                    </span>
                  ) : null}
                  <span className="min-w-0 truncate">{value.text}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(tab)}
          className="ws-route-panel"
        >
          {notes.length ? (
            <div className="ws-route-note" data-ws-route-note="">
              {display.auto ? (
                <span className="ws-spark" aria-hidden>
                  ✦
                </span>
              ) : null}
              <div className="min-w-0">
                {notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            </div>
          ) : null}
          {tab === "workstream" ? (
            <WorkstreamOptions
              variant="sheet"
              newWork={newWork}
              entities={entities}
              query={queries.workstream}
              onQueryChange={(query) =>
                setQueries((current) => ({ ...current, workstream: query }))
              }
              onDone={close}
            />
          ) : (
            <IdentityOptions
              variant="sheet"
              newWork={newWork}
              entities={entities}
              query={queries.identity}
              onQueryChange={(query) =>
                setQueries((current) => ({ ...current, identity: query }))
              }
              onDone={close}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
