// Workstreams frontend entry: the sidebar thread list, the Workstreams page,
// the optional parent link in thread headers, and the settings section.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ThreadDebugButton } from "./debug/ThreadDebugButton.tsx";
import { ParentThreadLink } from "./header/ParentLink.tsx";
import { ProposalBanner } from "./header/ProposalBanner.tsx";
import { RouteBanner } from "./composer/RouteBanner.tsx";
import { RecapCard } from "./composer/RecapCard.tsx";
import { ArchiveCard } from "./composer/ArchiveCard.tsx";
import { AutomaticFilingCard } from "./composer/AutomaticFilingCard.tsx";
import { WorkstreamsPage } from "./page/Page.tsx";
import { SpinnerSettings } from "./settings/SpinnerSettings.tsx";
import { WorkstreamsThreadList } from "./sidebar/ThreadList.tsx";
import "./styles.css";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "automatic-filing",
    scopes: ["thread"],
    banners: [{ id: "filing", chrome: "bare", component: AutomaticFilingCard }],
  });
  app.composer.customize({
    id: "recap",
    scopes: ["thread"],
    banners: [{ id: "recap", chrome: "bare", component: RecapCard }],
  });
  // Kept as a compatibility registration while clients migrate to the recap header.
  app.composer.customize({
    id: "archive-suggestion",
    scopes: ["thread"],
    actions: [{ id: "archive", component: ArchiveCard }],
  });
  app.composer.customize({
    id: "router",
    scopes: ["new-thread"],
    banners: [{ id: "route", chrome: "bare", component: RouteBanner }],
  });
  app.slots.experimental_threadHeaderAction({
    id: "parent-thread",
    title: "Parent thread",
    component: ParentThreadLink,
  });
  app.slots.experimental_threadHeaderAction({
    id: "workstream-proposal",
    title: "Workstream proposal",
    component: ProposalBanner,
  });
  // Renders only in Debug mode (SPEC §11.6).
  app.slots.experimental_threadHeaderAction({
    id: "debug",
    title: "Workstreams model calls",
    component: ThreadDebugButton,
  });
  // Slot and panel ids match v1 so the sidebar selection and page URL
  // (/plugins/workstreams/home) carry over.
  app.slots.experimental_threadList({
    id: "sidebar",
    title: "Workstreams",
    description:
      "Threads grouped by workstream (BB section), with Needs you and Recent at the top.",
    component: WorkstreamsThreadList,
  });
  app.slots.settingsSection({
    id: "spinner",
    title: "Working indicator",
    description: "How Workstreams marks a thread that's working.",
    component: SpinnerSettings,
  });
  app.slots.navPanel({
    id: "home",
    title: "Workstreams",
    icon: "Layers",
    path: "home",
    component: WorkstreamsPage,
  });
});
