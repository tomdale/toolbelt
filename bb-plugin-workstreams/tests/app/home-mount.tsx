// Mounts the phone Home section the way BB does: a `homepageSection` slot
// inside BB's compact home scroll viewport, with a mocked thread list and
// plugin state.
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarSection,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { emptyState, section, sidebarThread } from "./fixtures.ts";

export { section, sidebarThread };

export const homeSections = [
  section("sec_a", "Alpha"),
  section("sec_b", "Beta"),
  section("sec_z", "Zeta"),
];

export type SidebarPrefs = Partial<{
  showForYou: boolean;
  showRecent: boolean;
  showSnoozed: boolean;
  showArchived: boolean;
  phoneHome: boolean;
  groupSort: "alphabetical" | "activity" | "manual";
  timestamps: "show" | "hover" | "hide";
  threadCount: "always" | "collapsed" | "never";
  waitingCount: "always" | "collapsed" | "never";
}>;

export type HomeOptions = {
  threads?: PluginSidebarThread[];
  sections?: PluginSidebarSection[];
  status?: "loading" | "ready" | "error";
  prefs?: SidebarPrefs;
  analysis?: Record<string, unknown>;
  recaps?: Record<string, unknown>;
  order?: { workstreams?: string[]; prioritized?: string[] };
  snoozes?: Record<
    string,
    { until: number | null; attentionAt: number; at: number }
  >;
  /** Where the slot is mounted; BB's compact home viewport by default. */
  placement?: "compact" | "bare";
};

/** Everything but the `sidebar` group falls back to the plugin's defaults. */
function prefsResponse(prefs: SidebarPrefs = {}) {
  return {
    prefs: {
      sidebar: {
        showForYou: true,
        showRecent: true,
        showSnoozed: true,
        showArchived: true,
        phoneHome: true,
        recentLimit: 5,
        groupSort: "alphabetical",
        timestamps: "show",
        threadCount: "collapsed",
        waitingCount: "collapsed",
        ...prefs,
      },
    },
  };
}

export async function mountHome(options: HomeOptions = {}) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const registration = app.homepageSections[0];
  if (!registration) throw new Error("No homepage section registered");
  const Section = registration.component;
  const compact = options.placement !== "bare";
  const threads = options.threads ?? [];
  function Mounted() {
    return compact ? (
      <div data-testid="root-compose-compact-scroll-viewport">
        <div data-testid="plugin-homepage-sections">
          <section>
            <h2>{registration!.title}</h2>
            <div data-bb-plugin-root="">
              <Section projectId={null} />
            </div>
          </section>
        </div>
      </div>
    ) : (
      <Section projectId={null} />
    );
  }
  const slot = renderSlot(
    { component: Mounted },
    {},
    {
      sidebarThreads: {
        status: options.status ?? "ready",
        threads,
        sections: options.sections ?? homeSections,
        projects: [],
      },
      rpc: {
        prefs: () => prefsResponse(options.prefs),
        state: () => ({
          ...emptyState(),
          analysis: options.analysis ?? {},
          recaps: options.recaps ?? {},
          order: {
            workstreams: options.order?.workstreams ?? [],
            threads: {},
            prioritized: options.order?.prioritized ?? [],
          },
          snoozes: options.snoozes ?? {},
          snoozePrefs: {},
        }),
      },
    },
  );
  return slot;
}

/** A current analysis result that asks the user to decide. */
export function decisionFor(revision: number, ask = "Decide?") {
  return {
    recap: "Asked.",
    state: "needs_decision",
    needsYou: ask,
    subject: null,
    drift: null,
    driftSectionId: null,
    revision,
    at: Date.now(),
    model: "m",
  };
}

/** A stored agent recap of the given state. */
export function recapOf(state: "complete" | "review" | "waiting") {
  return {
    id: `r-${state}`,
    turnId: "turn",
    at: Date.now(),
    state,
    goal: "Shipping",
    latest: [`Reported ${state}`],
    review: state === "review" ? ["Try it"] : [],
    links: [],
  };
}
