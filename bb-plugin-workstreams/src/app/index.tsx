// Workstreams frontend entry: the sidebar thread list, the Workstreams page,
// thread header actions (parent link, snooze), the recap card, and the
// settings sections.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ServerStateRealtime } from "./serverState.ts";
import { ThreadDebugButton } from "./debug/ThreadDebugButton.tsx";
import { ParentThreadLink } from "./header/ParentLink.tsx";
import { RecapCard } from "./composer/RecapCard.tsx";
import { NewWorkControls } from "./composer/NewWorkControls.tsx";
import { ContinueAction } from "./composer/ContinueAction.tsx";
import { WorkstreamsPage } from "./page/Page.tsx";
import { SpinnerSettings } from "./settings/SpinnerSettings.tsx";
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
  app.composer.customize({
    id: "new-work",
    scopes: ["new-thread"],
    banners: [{ id: "intake", chrome: "bare", component: NewWorkControls }],
    actions: [{ id: "continue", component: ContinueAction }],
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
      "Threads grouped by workstream (BB section), with For you and Recent at the top.",
    component: WorkstreamsThreadList,
  });
  app.slots.settingsSection({
    id: "recap",
    title: "Recap",
    description:
      "The agent's recap above each thread's composer: whether agents write one, reminders, and layout.",
    component: RecapSettings,
  });
  app.slots.settingsSection({
    id: "snooze",
    title: "Snooze",
    description:
      "What a click on a snooze button does, the sidebar's hover menu, and when morning is.",
    component: SnoozeSettings,
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
