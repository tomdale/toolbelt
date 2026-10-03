/**
 * The phone Home screen. On a phone BB's new-thread view is the composer
 * pinned to the bottom with a flat list of recent threads above it. This
 * section, registered as BB's `homepageSection`, replaces that list with Up
 * Next, in the sidebar's amber block, over the threads grouped by workstream.
 * See `layout.ts` for how it takes BB's list's place, and `home.css` for the
 * rules that do. Wide windows render nothing: the sidebar is there.
 */
import {
  Component,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PluginHomepageSectionProps } from "@get-bb/plugin-sdk/app";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { workstreamHue } from "../../domain/workstreamHue.ts";
import { usePrefs } from "../prefs.ts";
import { useWorkstreams } from "../useWorkstreams.ts";
import { WorkstreamGroups, type HomeEnv } from "./Groups.tsx";
import { UpNextBlock } from "./UpNextBlock.tsx";
import { detectPlacement, homeMode, type Placement } from "./layout.ts";
import { planHome, prioritizedSet } from "./model.ts";
import { useHomeState } from "./useHomeState.ts";
import "./home.css";

export function HomeSection(_props: PluginHomepageSectionProps) {
  const narrowViewport = useIsCompactViewport();
  const probe = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  // Layout effects run before paint, so BB's own list never flashes.
  useLayoutEffect(
    () => setPlacement(detectPlacement(probe.current, narrowViewport)),
    [narrowViewport],
  );
  return (
    <>
      <span ref={probe} hidden data-ws-home-probe="" />
      {placement && placement !== "wide" ? (
        <HomeBoundary>
          <HomeScreen placement={placement} />
        </HomeBoundary>
      ) : (
        <span hidden data-ws-home="hidden" />
      )}
    </>
  );
}

/** A failure here must never take BB's own Recent list down with it. */
class HomeBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error) {
    console.warn(
      "[workstreams] The Home screen failed; BB's Recent list stays.",
      error,
    );
  }

  override render() {
    return this.state.failed ? (
      <span hidden data-ws-home="hidden" />
    ) : (
      this.props.children
    );
  }
}

function HomeScreen({ placement }: { placement: Exclude<Placement, "wide"> }) {
  const ws = useWorkstreams();
  const { prefs } = usePrefs();
  const state = useHomeState();
  const { server, sections, projection } = ws;
  const prioritized = useMemo(
    () => prioritizedSet(server.order, sections),
    [server.order, sections],
  );
  const groupSort = prefs?.sidebar.groupSort ?? "alphabetical";
  const plan = useMemo(
    () =>
      planHome(projection, {
        recaps: server.recaps,
        prioritized,
        groupSort,
        showUpNext: ws.showForYou,
        showSnoozed: ws.showSnoozed,
      }),
    [
      projection,
      server.recaps,
      prioritized,
      groupSort,
      ws.showForYou,
      ws.showSnoozed,
    ],
  );
  const mode = homeMode({
    placement,
    enabled: prefs?.sidebar.phoneHome ?? true,
    status: ws.status,
    hasContent: !plan.isEmpty,
  });
  if (mode === "hidden") return <span hidden data-ws-home="hidden" />;

  const nameOf = new Map(sections.map((section) => [section.id, section.name]));
  const env: HomeEnv = {
    now: ws.now,
    work: ws.work,
    snoozeOf: ws.snoozeOf,
    showAge: (prefs?.sidebar.timestamps ?? "show") === "show",
    threadCount: prefs?.sidebar.threadCount ?? "collapsed",
    waitingCount: prefs?.sidebar.waitingCount ?? "collapsed",
    ...state,
  };
  return (
    <div className="ws-home" data-ws-home={mode}>
      {ws.status === "loading" ? (
        <div role="status" className="ws-home-skeleton">
          <span className="sr-only">Loading threads…</span>
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </div>
      ) : ws.status === "error" ? (
        <p role="alert" className="ws-home-error">
          Couldn't load threads.
        </p>
      ) : (
        <>
          {plan.upNext ? (
            <UpNextBlock
              rows={plan.upNext.rows}
              focused={plan.upNext.focused}
              work={ws.work}
              workstreamOf={(row) => {
                const name = row.workstreamId
                  ? nameOf.get(row.workstreamId)
                  : undefined;
                return row.workstreamId && name
                  ? { name, hue: workstreamHue(row.workstreamId) }
                  : null;
              }}
              now={ws.now}
              showAge={env.showAge}
            />
          ) : null}
          <WorkstreamGroups plan={plan} env={env} />
        </>
      )}
    </div>
  );
}
