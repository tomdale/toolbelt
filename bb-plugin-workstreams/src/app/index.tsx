// Workstreams frontend entry: the sidebar thread list, the Workstreams page,
// and the optional parent link in thread headers.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ParentThreadLink } from "./header/ParentLink.tsx";
import { ProposalBanner } from "./header/ProposalBanner.tsx";
import { WorkstreamsPage } from "./page/Page.tsx";
import { WorkstreamsThreadList } from "./sidebar/ThreadList.tsx";
import "./styles.css";

export default definePluginApp((app) => {
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
  // Slot and panel ids match v1 so the sidebar selection and page URL
  // (/plugins/workstreams/home) carry over.
  app.slots.experimental_threadList({
    id: "sidebar",
    title: "Workstreams",
    description:
      "Threads grouped by workstream (BB section), with Needs you and Recent at the top.",
    component: WorkstreamsThreadList,
  });
  app.slots.navPanel({
    id: "home",
    title: "Workstreams",
    icon: "Layers",
    path: "home",
    component: WorkstreamsPage,
  });
});
