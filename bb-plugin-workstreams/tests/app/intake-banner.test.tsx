// @vitest-environment jsdom
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { Intake, IntakeContext } from "../../src/app/composer/intake.ts";
import {
  IntakeBanner,
  IntakeStatus,
} from "../../src/app/composer/IntakeBanner.tsx";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type {
  NewThreadDecision,
  RouteDecision,
} from "../../src/server/router.ts";
import { emptyState } from "./fixtures.ts";
afterEach(cleanup);
const base = {
  id: "d1",
  confidence: "high" as const,
  reason: "",
  subject: null,
  traceId: null,
};
const decision: NewThreadDecision = {
  ...base,
  outcome: "new-thread",
  sectionId: "sec_a",
  workstream: "Alpha",
  title: "Fix parser",
  placement: {
    projectId: "proj_a",
    environment: { type: "project-default" },
    label: "checkout",
  },
};
const PROMPT = "Fix the parser so it handles tabs";
const continuation: RouteDecision = {
  ...base,
  id: "d_continue",
  outcome: "continue",
  threadId: "thr_p",
  threadTitle: "Parser tabs",
  sectionId: "sec_a",
  workstream: "Alpha",
  alternative: { ...decision, id: "d_new", title: "" },
};
async function mount(
  first: RouteDecision = decision,
  text = PROMPT,
  workstreamId: string | null = null,
) {
  const Banner = IntakeBanner;
  const route = vi.fn().mockResolvedValue(first);
  const intake = new Intake(route, workstreamId, workstreamId ? "Alpha" : null);
  let remount!: () => void;
  const slot = renderSlot(
    {
      component: function Host() {
        const [scope, setScope] = useState(0);
        remount = () => setScope((n) => n + 1);
        return (
          <IntakeContext.Provider value={intake}>
            <Banner key={scope} intake={intake} />
            <IntakeStatus intake={intake} />
          </IntakeContext.Provider>
        );
      },
    },
    {},
    {
      composer: {
        text,
        scope: { kind: "new-thread", projectId: "incidental_host_project" },
      },
      sdk: {
        projects: {
          list: async () => [
            {
              id: "proj_a",
              name: "bb",
              kind: "standard",
              sources: [{ hostId: "host_a" }],
            },
            {
              id: "proj_b",
              name: "dotfiles",
              kind: "standard",
              sources: [{ hostId: "host_a" }],
            },
            {
              id: "proj_personal",
              name: "Personal",
              kind: "personal",
              sources: [{ hostId: "host_a" }],
            },
            {
              id: "proj_nongit",
              name: "NonGitProject",
              kind: "standard",
              sources: [{ hostId: "host_a" }],
            },
          ],
        },
        system: { config: async () => ({ primaryHostId: "host_a" }) },
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            title: "Parser",
            sectionId: "sec_a",
            projectId: "proj_b",
            environmentId: "env_p",
            environment: { name: "Parser worktree" },
          }),
          defaultExecutionOptions: async () => ({
            providerId: "codex",
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "auto",
          }),
          list: async () => [
            {
              id: "thr_p",
              title: "Parser tabs",
              sectionId: "sec_a",
              projectId: "proj_b",
              environmentId: "env_p",
              environmentName: "Parser worktree",
            },
          ],
        },
        environments: {
          list: async ({ projectId }: { projectId: string }) =>
            projectId === "proj_a"
              ? [
                  { id: "env_a", name: "Alpha checkout", status: "ready" },
                  {
                    id: "env_branch",
                    name: null,
                    branchName: "feat/parser",
                    isWorktree: true,
                    status: "ready",
                  },
                ]
              : projectId === "proj_personal"
                ? [
                    {
                      id: "env_pers_1",
                      name: null,
                      environmentProviderId: "personal-workspace",
                      path: "/workspaces/thr_trip",
                      status: "ready",
                    },
                  ]
                : [],
          listProviders: async ({ projectId }: { projectId: string }) =>
            projectId === "proj_personal"
              ? [
                  {
                    id: "personal-workspace",
                    displayName: "Personal workspace",
                    availability: { status: "available" },
                  },
                ]
              : projectId === "proj_nongit"
                ? [
                    {
                      id: "project-checkout",
                      displayName: "Project checkout",
                      availability: { status: "available" },
                    },
                    {
                      id: "custom-container",
                      displayName: "Docker container",
                      acceptsEmptyInputs: false,
                      availability: { status: "available" },
                    },
                  ]
                : [
                    {
                      id: "project-checkout",
                      displayName: "Project checkout",
                      availability: { status: "available" },
                    },
                    {
                      id: "git-worktree",
                      displayName: "New worktree",
                      availability: { status: "available" },
                    },
                  ],
        },
      } as unknown as PluginBrowserBbSdk,
      rpc: {
        state: () => ({
          ...emptyState(),
          workstreams: {
            sec_a: { sectionId: "sec_a", name: "Alpha" },
            sec_b: { sectionId: "sec_b", name: "Beta" },
          },
        }),
      },
    },
  );
  return { slot, intake, route, remount: () => act(() => remount()) };
}
async function choose(
  slot: Awaited<ReturnType<typeof mount>>["slot"],
  field: string,
  option: string,
) {
  fireEvent.click(slot.getByRole("button", { name: new RegExp(`^${field}:`) }));
  fireEvent.click(await slot.findByRole("menuitem", { name: option }));
}
it("idle controls have four solid stars, no Settings or duplicate Action label, and blank stable status", async () => {
  const { slot, intake, route } = await mount(decision, "");
  expect(slot.container.querySelectorAll(".ws-intake-star")).toHaveLength(4);
  expect(slot.container.querySelector(".ws-intake-status")?.textContent).toBe(
    "",
  );
  expect(slot.container.textContent).not.toContain("Settings");
  expect(
    slot.container.querySelector(".ws-intake-action .ws-intake-type"),
  ).toBeNull();
  expect(route).not.toHaveBeenCalled();
  intake.dispose();
});
it("automatic fill keeps labelled placement and automatic stars", async () => {
  const { slot, intake, route } = await mount();
  await waitFor(() => expect(intake.canSubmit()).toBe(true), { timeout: 2000 });
  expect(slot.container.querySelectorAll(".ws-intake-star")).toHaveLength(4);
  expect(slot.getByRole("button", { name: /^Project:/ }).textContent).toContain(
    "bb",
  );
  expect(route).toHaveBeenCalledWith({ prompt: PROMPT, intent: {} });
  intake.dispose();
});
it("wrong-workstream correction persists across edits and destination revert has a preview", async () => {
  const { slot, intake } = await mount();
  await waitFor(() => expect(intake.canSubmit()).toBe(true), { timeout: 2000 });
  await choose(slot, "Workstream", "Beta");
  await slot.behavior.setComposerText("Fix the other parser");
  await waitFor(() => expect(intake.snapshot().loading).toBe(false), {
    timeout: 2000,
  });
  expect(
    slot.getByRole("button", { name: /^Workstream:/ }).textContent,
  ).toContain("Beta");
  expect(
    slot.container.querySelector(".ws-intake-action .ws-intake-revert"),
  ).toBeNull();
  expect(slot.container.querySelectorAll(".ws-intake-star")).toHaveLength(2);
  fireEvent.click(
    slot.getByRole("button", { name: "Use automatic destination: Alpha" }),
  );
  await waitFor(() =>
    expect(intake.snapshot().destination.source).toBe("automatic"),
  );
  intake.dispose();
});
it("an inferred continuation keeps the new thread's fields and adds no route-row control", async () => {
  const { slot, intake, route } = await mount();
  await waitFor(() => expect(intake.canSubmit()).toBe(true), { timeout: 2000 });
  route.mockResolvedValue(continuation);
  await slot.behavior.setComposerText("Continue with parser tabs");
  await waitFor(
    () => expect(intake.snapshot().suggestion?.threadId).toBe("thr_p"),
    { timeout: 2000 },
  );
  await waitFor(() => expect(intake.canSubmit()).toBe(true));
  expect(slot.getByRole("button", { name: /^Action:/ }).textContent).toContain(
    "New thread",
  );
  expect(
    slot.getByRole("button", { name: /^Workstream:/ }).textContent,
  ).toContain("Alpha");
  // The composer's own action row offers the continuation.
  expect(slot.queryByRole("button", { name: /^Continue/ })).toBeNull();
  expect(slot.container.querySelector(".ws-intake-status")?.textContent).toBe(
    "Filled automatically. Suggested: continue Parser tabs",
  );
  intake.dispose();
});
it("manual placement, focus and catalog survive host banner remount; Delete reverts one field", async () => {
  const { slot, intake, remount } = await mount();
  await waitFor(() => expect(intake.canSubmit()).toBe(true), { timeout: 2000 });
  await choose(slot, "Project", "bb");
  await choose(slot, "Environment", "New worktree");
  const project = slot.getByRole("button", { name: /^Project:/ });
  project.focus();
  remount();
  expect(document.activeElement).toBe(
    slot.getByRole("button", { name: /^Project:/ }),
  );
  expect(intake.snapshot().project.source).toBe("manual");
  expect(intake.snapshot().environment.source).toBe("manual");
  fireEvent.keyDown(slot.getByRole("button", { name: /^Environment:/ }), {
    key: "Delete",
  });
  expect(intake.snapshot().environment.source).toBe("automatic");
  expect(intake.snapshot().project.source).toBe("manual");
  intake.dispose();
});
it("ambiguity preselects nothing; errors retain yellow stars and expose Retry", async () => {
  const { slot, intake, route } = await mount({
    ...base,
    outcome: "unsure",
    candidates: [
      { kind: "thread", threadId: "thr_p", title: "Parser tabs" },
      { kind: "workstream", sectionId: "sec_b", name: "Beta" },
    ],
  });
  await slot.findByRole(
    "group",
    { name: "Possible destinations" },
    { timeout: 2000 },
  );
  expect(intake.snapshot().destination.value.kind).toBe("automatic");
  expect(slot.container.querySelectorAll(".ws-intake-star")).toHaveLength(4);
  route.mockRejectedValue(new Error("offline"));
  act(() => intake.retry());
  await waitFor(() => expect(intake.snapshot().error).toBe("offline"), {
    timeout: 2000,
  });
  expect(slot.container.querySelectorAll(".ws-intake-star")).toHaveLength(4);
  expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
  intake.dispose();
});
it("No workstream search finds unassigned, asks for project, and omits connector", async () => {
  const { slot, intake, route } = await mount();
  await waitFor(() => expect(intake.canSubmit()).toBe(true), { timeout: 2000 });
  route.mockResolvedValue({
    ...decision,
    sectionId: null,
    workstream: null,
    placement: null,
  });
  fireEvent.click(slot.getByRole("button", { name: /^Workstream:/ }));
  fireEvent.change(slot.getByRole("textbox", { name: "Search workstream" }), {
    target: { value: "unassigned" },
  });
  fireEvent.click(slot.getByRole("menuitem", { name: "No workstream" }));
  await waitFor(() => expect(intake.snapshot().loading).toBe(false));
  expect(
    slot.container.querySelector(".ws-intake-route-row .ws-intake-connector"),
  ).toBeNull();
  expect(slot.container.querySelector(".ws-intake-status")?.textContent).toBe(
    "Pick a project",
  );
  expect(intake.canSubmit()).toBe(false);
  await choose(slot, "Project", "dotfiles");
  expect(intake.intent()).toMatchObject({
    destination: { kind: "none" },
    placement: { projectId: "proj_b" },
  });
  intake.dispose();
});
it("new-workstream name is editable with an individual revert", async () => {
  const { slot, intake } = await mount({
    ...base,
    outcome: "new-workstream",
    name: "Offline sync",
    description: "",
    title: PROMPT,
    placement: decision.placement,
  });
  const input = await slot.findByRole(
    "textbox",
    { name: "Workstream name" },
    { timeout: 2000 },
  );
  fireEvent.change(input, { target: { value: "My spike" } });
  expect(intake.intent().workstreamName).toBe("My spike");
  fireEvent.click(
    slot.getByRole("button", { name: "Use automatic name: Offline sync" }),
  );
  expect(intake.snapshot().name.source).toBe("automatic");
  intake.dispose();
});
it("ArrowDown, Home, End, Escape and Tab keep menus keyboard accessible", async () => {
  const { slot, intake } = await mount(decision, "");
  const trigger = slot.getByRole("button", { name: /^Action:/ });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const menu = slot.getByRole("menu", { name: "Action choices" });
  fireEvent.keyDown(menu, { key: "End" });
  expect(document.activeElement?.textContent).toBe("New workstream");
  fireEvent.keyDown(menu, { key: "Home" });
  expect(document.activeElement?.textContent).toContain("Automatic");
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyDown(slot.getByRole("menu"), { key: "Tab" });
  expect(document.activeElement).toBe(trigger);
  intake.dispose();
});

it("opens the action menu on its first item so arrow keys can select an action", async () => {
  const { slot, intake } = await mount(decision, "");
  const trigger = slot.getByRole("button", { name: /^Action:/ });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    slot.getByRole("menuitem", { name: "Automatic" }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    slot.getByRole("menuitem", { name: "New thread" }),
  );
  fireEvent.click(document.activeElement!);
  expect(intake.snapshot().action).toEqual({
    value: "new-thread",
    source: "manual",
  });
  expect(document.activeElement).toBe(trigger);
  intake.dispose();
});
it("a routed thread outside the initial catalog gets accurate placement and execution settings", async () => {
  const { slot, intake } = await mount({
    ...continuation,
    threadId: "thr_outside",
    threadTitle: "Outside catalog",
    sectionId: null,
    workstream: null,
  });
  // mount's SDK get fixture is the authoritative target rather than a list guess.
  act(() =>
    intake.selectDestination({
      kind: "thread",
      id: "thr_outside",
      title: "Outside catalog",
    }),
  );
  await waitFor(() =>
    expect(
      slot.inspection.composer.selections.some(
        (s) => s.environment?.type === "reuse",
      ),
    ).toBe(true),
  );
  expect(slot.getByRole("button", { name: /^Project:/ }).textContent).toContain(
    "dotfiles",
  );
  expect(
    slot.getByRole("button", { name: /^Environment:/ }).textContent,
  ).toContain("Parser worktree");
  intake.dispose();
});

it.skipIf(!process.env.NEW_WORK_CAPTURE_DIR)(
  "exports actual component states for standalone screenshots",
  async () => {
    const directory = process.env.NEW_WORK_CAPTURE_DIR!;
    await mkdir(directory, { recursive: true });
    const css = await readFile("src/app/styles.css", "utf8");
    async function capture(
      name: string,
      slot: Awaited<ReturnType<typeof mount>>["slot"],
    ) {
      const markup = slot.container.querySelector(
        ".ws-intake-controls",
      )!.outerHTML;
      const tokens = `:root{color-scheme:dark;--border:#2a2a2d;--background:#131315;--foreground:#ededef;--muted-foreground:#8d8d93;--popover:#1a1a1d;--accent:#212124;--ring:#7aa2ff;--destructive:#f07a7a;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}*{box-sizing:border-box}body{margin:0;background:#070708;color:var(--foreground);padding:40px 16px}button,input{font:inherit;color:inherit;background:transparent;border:0}button{padding:0}p{margin:0}.capture-dialog{width:640px;max-width:100%;margin:auto;border:1px solid var(--border);border-radius:14px;padding:20px;box-shadow:0 24px 80px #0006}.capture-dialog h1{font-size:16px;margin:0 0 14px}.composer-placeholder{margin-top:6px;min-height:100px;border:1px solid var(--border);border-radius:14px;padding:14px;color:var(--muted-foreground);font-size:14px}.capture-note{font-size:11px;color:var(--muted-foreground);margin-top:20px}.size-3,.size-3\\.5{width:14px;height:14px;display:inline-block;flex:none}.shrink-0{flex-shrink:0}.text-muted-foreground{color:var(--muted-foreground)}[data-icon=ChevronDown]::after{content:'⌄'}[data-icon=Folder]::after{content:'▱'}[data-icon=Layers]::after{content:'◇'}[data-icon=Plus]::after{content:'+'}[data-icon=Lock]::after{content:'▣'}[data-icon=MessageSquare]::after{content:'▢'}@media(max-width:767px){.capture-dialog{padding:16px}.capture-dialog h1{margin-bottom:14px}}`;
      await writeFile(
        join(directory, `${name}.html`),
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${tokens}\n${css}</style><div class="capture-dialog"><h1>New work</h1>${markup}<div class="composer-placeholder">What's the work?</div><p class="capture-note">Actual IntakeBanner markup and production CSS. Native composer and SDK icons are test stand-ins.</p></div>`,
      );
    }
    let fixture = await mount(decision, "");
    await capture("idle", fixture.slot);
    fixture.intake.dispose();
    fixture.slot.lifecycle.unmount();
    fixture = await mount();
    await waitFor(() => expect(fixture.intake.canSubmit()).toBe(true), {
      timeout: 2000,
    });
    await capture("ready", fixture.slot);
    await choose(fixture.slot, "Workstream", "Beta");
    await waitFor(() => expect(fixture.intake.snapshot().loading).toBe(false));
    await capture("manual", fixture.slot);
    fixture.intake.dispose();
    fixture.slot.lifecycle.unmount();
    fixture = await mount(continuation);
    await waitFor(() => expect(fixture.intake.canSubmit()).toBe(true), {
      timeout: 2000,
    });
    await capture("suggestion", fixture.slot);
    fixture.route.mockResolvedValue({
      ...continuation,
      alternative: undefined,
    });
    act(() =>
      fixture.intake.selectDestination({
        kind: "thread",
        id: "thr_p",
        title: "Parser tabs",
      }),
    );
    await waitFor(() => expect(fixture.intake.canSubmit()).toBe(true), {
      timeout: 2000,
    });
    await capture("thread", fixture.slot);
    fixture.intake.dispose();
    fixture.slot.lifecycle.unmount();
    fixture = await mount({
      ...decision,
      workstream:
        "Workstreams plugin with a long descriptive name that must truncate before the type label",
    });
    await waitFor(() => expect(fixture.intake.canSubmit()).toBe(true), {
      timeout: 2000,
    });
    await capture("long-values", fixture.slot);
    fixture.intake.selectUnassigned();
    fixture.route.mockResolvedValue({
      ...decision,
      sectionId: null,
      workstream: null,
      placement: null,
    });
    await act(async () => {
      await fixture.intake.resolve();
    });
    await capture("no-workstream", fixture.slot);
    fixture.intake.dispose();
    fixture.slot.lifecycle.unmount();
  },
);

it("BUG-2: Personal project offers Personal workspace and excludes Project checkout / New worktree", async () => {
  const { slot, intake } = await mount();
  await waitFor(() => expect(intake.canSubmit()).toBe(true), { timeout: 2000 });
  await choose(slot, "Project", "Personal");
  await waitFor(() =>
    expect(intake.snapshot().project.value).toBe("proj_personal"),
  );

  fireEvent.click(slot.getByRole("button", { name: /^Environment:/ }));

  expect(
    slot.getByRole("menuitem", { name: "Personal workspace" }),
  ).toBeTruthy();
  expect(slot.queryByRole("menuitem", { name: "Project checkout" })).toBeNull();
  expect(slot.queryByRole("menuitem", { name: "New worktree" })).toBeNull();

  expect(
    slot.getByRole("menuitem", {
      name: "Personal workspace (thr_trip)",
    }),
  ).toBeTruthy();
  expect(slot.queryByRole("menuitem", { name: /env_pers_1/ })).toBeNull();
  expect(
    slot.queryByRole("menuitem", { name: "Unnamed environment" }),
  ).toBeNull();

  intake.dispose();
});

it("BUG-5: Standard project environment menu displays derived metadata labels without raw env IDs", async () => {
  const { slot, intake } = await mount();
  await waitFor(() => expect(intake.canSubmit()).toBe(true), { timeout: 2000 });

  fireEvent.click(slot.getByRole("button", { name: /^Environment:/ }));

  expect(slot.getByRole("menuitem", { name: "Project checkout" })).toBeTruthy();
  expect(slot.getByRole("menuitem", { name: "New worktree" })).toBeTruthy();
  expect(
    slot.queryByRole("menuitem", { name: "Personal workspace" }),
  ).toBeNull();

  expect(
    slot.getByRole("menuitem", { name: "Worktree (feat/parser)" }),
  ).toBeTruthy();
  expect(slot.queryByRole("menuitem", { name: /env_branch/ })).toBeNull();
  expect(
    slot.queryByRole("menuitem", { name: "Unnamed environment" }),
  ).toBeNull();

  intake.dispose();
});

it("BUG-3: recovery button recovers from invalid selection by resetting to automatic", async () => {
  const { slot, intake } = await mount();
  await waitFor(() => expect(intake.canSubmit()).toBe(true), { timeout: 2000 });

  intake.selectEnvironment({
    type: "host",
    hostId: "host_a",
    workspace: { type: "unmanaged", path: null },
  });
  expect(intake.snapshot().environment.source).toBe("manual");

  act(() => {
    intake.selectionFailed("Choose an environment the composer can use.");
  });
  expect(intake.snapshot().selectionError).toBe(
    "Choose an environment the composer can use.",
  );

  const retryBtn = slot.getByRole("button", { name: "Retry" });
  expect(retryBtn.getAttribute("title")).toBe(
    "Reset to automatic environment and retry",
  );

  fireEvent.click(retryBtn);
  expect(intake.snapshot().selectionError).toBeNull();
  expect(intake.snapshot().environment.source).toBe("automatic");

  intake.dispose();
});

it("non-git project: excludes New worktree and input-requiring providers from choices", async () => {
  const { slot, intake } = await mount();
  await waitFor(() => expect(intake.canSubmit()).toBe(true), { timeout: 2000 });
  await choose(slot, "Project", "NonGitProject");
  await waitFor(() =>
    expect(intake.snapshot().project.value).toBe("proj_nongit"),
  );

  fireEvent.click(slot.getByRole("button", { name: /^Environment:/ }));

  expect(slot.getByRole("menuitem", { name: "Project checkout" })).toBeTruthy();
  // Non-git project must NOT offer New worktree
  expect(slot.queryByRole("menuitem", { name: "New worktree" })).toBeNull();
  // Provider requiring input (acceptsEmptyInputs: false) must NOT be offered
  expect(slot.queryByRole("menuitem", { name: "Docker container" })).toBeNull();

  intake.dispose();
});

it("recovers from project selection error with project reset tooltip and clears manual project", async () => {
  const { slot, intake } = await mount();
  await waitFor(() => expect(intake.canSubmit()).toBe(true), { timeout: 2000 });

  intake.selectProject("proj_bad");
  expect(intake.snapshot().project.source).toBe("manual");

  act(() => {
    intake.selectionFailed("Choose a project the composer can use.");
  });
  expect(intake.snapshot().selectionError).toBe(
    "Choose a project the composer can use.",
  );

  const retryBtn = slot.getByRole("button", { name: "Retry" });
  expect(retryBtn.getAttribute("title")).toBe(
    "Reset to automatic project and retry",
  );

  fireEvent.click(retryBtn);
  expect(intake.snapshot().selectionError).toBeNull();
  expect(intake.snapshot().project.source).toBe("automatic");
  expect(intake.snapshot().environment.source).toBe("automatic");

  intake.dispose();
});
