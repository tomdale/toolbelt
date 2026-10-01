// Workstreams frontend entry: the sidebar thread list, the Workstreams page,
// thread header actions (parent link, snooze), the recap card, and the
// settings sections.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ServerStateRealtime } from "./serverState.ts";
import { ThreadDebugButton } from "./debug/ThreadDebugButton.tsx";
import { ParentThreadLink } from "./header/ParentLink.tsx";
import { RecapCard } from "./composer/RecapCard.tsx";
import { NewWorkBridge } from "./composer/NewWorkBridge.tsx";
import { WorkstreamsPage } from "./page/Page.tsx";
import {
  AdvancedSettings,
  NewWorkSettings,
  OrganizeSettings,
  SidebarSettings,
  ThreadsSettings,
} from "./settings/FeatureSettings.tsx";
import { WorkstreamsThreadList } from "./sidebar/ThreadList.tsx";
import { RecapSettings } from "./recap/RecapSettings.tsx";
import {
  SnoozeHeaderAction,
  headerSnoozers,
} from "./snooze/SnoozeHeaderAction.tsx";
import { SnoozeSettings } from "./snooze/SnoozeSettings.tsx";
import "./styles.css";

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "server-state",
    component: ServerStateRealtime,
  });
  app.composer.customize({
    id: "recap",
    scopes: ["thread"],
    banners: [{ id: "recap", chrome: "bare", component: RecapCard }],
  });
  // Renders nothing; it hands New work the composer its dialog embeds.
  app.composer.customize({
    id: "new-work",
    scopes: ["new-thread"],
    banners: [{ id: "bridge", chrome: "bare", component: NewWorkBridge }],
  });
  app.slots.experimental_threadHeaderAction({
    id: "parent-thread",
    title: "Parent thread",
    component: ParentThreadLink,
  });
  app.slots.experimental_threadHeaderAction({
    id: "snooze",
    title: "Snooze",
    component: SnoozeHeaderAction,
  });
  app.commands.register({
    id: "snooze-thread",
    title: "Workstreams: snooze this thread",
    isAvailable: ({ threadId }) =>
      threadId !== null && headerSnoozers.get(threadId)?.snoozed === false,
    run: ({ threadId }) => {
      if (threadId !== null) headerSnoozers.get(threadId)?.snooze();
    },
  });
  app.commands.register({
    id: "wake-thread",
    title: "Workstreams: wake this snoozed thread",
    isAvailable: ({ threadId }) =>
      threadId !== null && headerSnoozers.get(threadId)?.snoozed === true,
    run: ({ threadId }) => {
      if (threadId !== null) headerSnoozers.get(threadId)?.wake();
    },
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
      "Threads grouped by workstream (BB section), with Up Next, prioritized workstreams, and Recent at the top.",
    component: WorkstreamsThreadList,
  });
  app.slots.settingsSection({
    id: "sidebar",
    title: "Sidebar",
    component: SidebarSettings,
  });
  app.slots.settingsSection({
    id: "threads",
    title: "Threads",
    component: ThreadsSettings,
  });
  app.slots.settingsSection({
    id: "recap",
    title: "Recap",
    component: RecapSettings,
  });
  app.slots.settingsSection({
    id: "snooze",
    title: "Snooze",
    component: SnoozeSettings,
  });
  app.slots.settingsSection({
    id: "new-work",
    title: "New work",
    component: NewWorkSettings,
  });
  app.slots.settingsSection({
    id: "organize",
    title: "Organize",
    component: OrganizeSettings,
  });
  app.slots.settingsSection({
    id: "advanced",
    title: "Advanced",
    component: AdvancedSettings,
  });
  app.slots.navPanel({
    id: "home",
    title: "Workstreams",
    icon: "Layers",
    path: "home",
    component: WorkstreamsPage,
  });
});
