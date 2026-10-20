import { useEffect, useState, type ReactNode } from "react";
import { experimental_useSidebarThreads, useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import { RECENT_LIMIT, type PrefsPatch } from "../../domain/prefs.ts";
import { usePrefs } from "../prefs.ts";
import { ModelField } from "./ModelField.tsx";
import { SpinnerSettings } from "./SpinnerSettings.tsx";
import {
  CompactSettingRow,
  SectionRows,
  SettingRow,
  SettingSwitch,
  SegmentedControl,
  SettingsPicker,
  Stepper,
} from "./ui.tsx";

function useFeaturePrefs() {
  const { prefs, save } = usePrefs();
  const [error, setError] = useState<string | null>(null);
  const update = (patch: PrefsPatch) => {
    setError(null);
    void save(patch).catch((cause) => {
      setError(
        cause instanceof Error ? cause.message : "Couldn't save setting.",
      );
    });
  };
  return { prefs, update, error };
}

export function SidebarSettings() {
  const { prefs, update, error } = useFeaturePrefs();
  if (!prefs) return <Loading />;
  const row = (
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
    accessory?: ReactNode,
  ) => (
    <CompactSettingRow
      label={label}
      accessory={accessory}
      control={
        <SettingSwitch
          size="sm"
          label={label}
          checked={checked}
          onChange={onChange}
        />
      }
    />
  );
  const choice = <V extends string>(
    label: string,
    value: V,
    options: readonly { value: V; label: string }[],
    onChange: (value: V) => void,
  ) => (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <p className="min-w-0 truncate text-sm text-foreground">{label}</p>
      <SegmentedControl
        label={label}
        value={value}
        options={options}
        onChange={onChange}
      />
    </div>
  );
  const countOptions = [
    { value: "always", label: "Always" },
    { value: "collapsed", label: "When collapsed" },
    { value: "never", label: "Never" },
  ] as const;
  return (
    <div className="space-y-4">
      <SettingsSaveError error={error} />
      <SidebarGroup title="Sections">
        <SectionRows compact>
          {row("Up Next", prefs.sidebar.showForYou, (showForYou) =>
            update({ sidebar: { showForYou } }),
          )}
          {row(
            "Recent",
            prefs.sidebar.showRecent,
            (showRecent) => update({ sidebar: { showRecent } }),
            prefs.sidebar.showRecent ? (
              <Stepper
                size="sm"
                label="threads shown"
                value={prefs.sidebar.recentLimit}
                min={RECENT_LIMIT.min}
                max={RECENT_LIMIT.max}
                onChange={(recentLimit) => update({ sidebar: { recentLimit } })}
              />
            ) : null,
          )}
          {row("Snoozed", prefs.sidebar.showSnoozed, (showSnoozed) =>
            update({ sidebar: { showSnoozed } }),
          )}
          {row("Archived", prefs.sidebar.showArchived, (showArchived) =>
            update({ sidebar: { showArchived } }),
          )}
        </SectionRows>
      </SidebarGroup>
      <SidebarGroup title="Home screen">
        <SectionRows compact>
          <SettingRow
            label="Up Next and workstreams on phones"
            description="Replaces BB's Recent list on a phone's Home screen with Up Next over your threads by workstream."
            control={
              <SettingSwitch
                size="sm"
                label="Up Next and workstreams on phones"
                checked={prefs.sidebar.phoneHome}
                onChange={(phoneHome) => update({ sidebar: { phoneHome } })}
              />
            }
          />
        </SectionRows>
      </SidebarGroup>
      <SidebarGroup title="Details">
        <SectionRows compact>
          {choice(
            "Timestamp",
            prefs.sidebar.timestamps,
            [
              { value: "show", label: "Always" },
              { value: "hover", label: "On hover" },
              { value: "hide", label: "Never" },
            ],
            (timestamps) => update({ sidebar: { timestamps } }),
          )}
          {choice(
            "Thread count",
            prefs.sidebar.threadCount,
            countOptions,
            (threadCount) => update({ sidebar: { threadCount } }),
          )}
          {choice(
            "Waiting count",
            prefs.sidebar.waitingCount,
            countOptions,
            (waitingCount) => update({ sidebar: { waitingCount } }),
          )}
        </SectionRows>
      </SidebarGroup>
    </div>
  );
}

function SidebarGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  );
}

export function WorkingIndicatorSettings() {
  return (
    <SectionRows>
      <div className="min-w-0">
        <p className="text-xs leading-relaxed text-muted-foreground">
          How a working thread is marked in the sidebar.
        </p>
        <div className="mt-3">
          <SpinnerSettings />
        </div>
      </div>
    </SectionRows>
  );
}

export function ThreadsSettings() {
  const { prefs, update, error } = useFeaturePrefs();
  if (!prefs) return <Loading />;
  return (
    <div className="space-y-3">
      <SettingsSaveError error={error} />
      <SectionRows>
        <ModelField
          label="Full analysis model"
          description="When a turn ends after a new request, settles the thread's goal (its title, while Keep titles current is on) and its topic, and its status when the agent didn't report one."
          choice={prefs.analysis.fullModel}
          onChange={(fullModel) => update({ analysis: { fullModel } })}
        />
        <SettingRow
          label="Keep titles current"
          description="Title new threads promptly and update titles to follow their current substantive focus. Titles you edit outside Workstreams stay fixed until you clear them."
          control={
            <SettingSwitch
              label="Keep titles current"
              checked={prefs.threads.autoTitle}
              onChange={(autoTitle) => update({ threads: { autoTitle } })}
            />
          }
        />
        <SettingRow
          label="Show parent thread link"
          description="Add a link to the parent thread in child thread headers."
          control={
            <SettingSwitch
              label="Show parent thread link"
              checked={prefs.threads.showParentLink}
              onChange={(showParentLink) =>
                update({ threads: { showParentLink } })
              }
            />
          }
        />
        <SettingRow
          label="Show archive button"
          description="Add an Archive button to thread headers."
          control={
            <SettingSwitch
              label="Show archive button"
              checked={prefs.threads.showArchiveButton}
              onChange={(showArchiveButton) =>
                update({ threads: { showArchiveButton } })
              }
            />
          }
        />
      </SectionRows>
    </div>
  );
}

export function NewWorkSettings() {
  const { prefs, update, error } = useFeaturePrefs();
  const { status, projects } = experimental_useSidebarThreads();
  if (!prefs) return <Loading />;
  const projectOptions = [
    { value: "", label: "Don't work in a project" },
    ...projects
      .filter((project) => !project.isPersonal)
      .map((project) => ({ value: project.id, label: project.name })),
  ];
  return (
    <div className="space-y-3">
      <SettingsSaveError error={error} />
      <SectionRows>
        <SettingRow
          label="Home project"
          description="Where new work starts when it has no project target."
          control={
            <SettingsPicker
              label="Home project"
              value={prefs.newWork.homeProjectId}
              options={projectOptions}
              placeholder={
                status === "loading" ? "Loading projects…" : "Choose a project"
              }
              onChange={(homeProjectId) =>
                update({ newWork: { homeProjectId } })
              }
              disabled={status !== "ready"}
              className="w-56"
            />
          }
        />
        <SettingRow
          label="Suggestions while typing"
          description="Preview a new thread's topic in the composer as you write, using the Quick analysis model."
          control={
            <SettingSwitch
              label="Suggestions while typing"
              checked={prefs.newWork.suggestions}
              onChange={(suggestions) => update({ newWork: { suggestions } })}
            />
          }
        />
        <ModelField
          label="Quick analysis model"
          description="Titles a new thread and picks its topic from its first request, and previews both in the composer as you type."
          choice={prefs.analysis.quickModel}
          onChange={(quickModel) => update({ analysis: { quickModel } })}
        />
      </SectionRows>
    </div>
  );
}

export function OrganizeSettings() {
  const { prefs, update, error } = useFeaturePrefs();
  if (!prefs) return <Loading />;
  return (
    <div className="space-y-3">
      <SettingsSaveError error={error} />
      <SectionRows>
        <SettingRow
          label="Group capacity"
          description="Most visible root threads per workstream, including completed threads, before it splits into subtopics. A single topic may exceed it."
          control={
            <Stepper
              label="Group capacity"
              value={prefs.organize.capacity}
              min={2}
              max={100}
              onChange={(capacity) =>
                update({
                  organize: {
                    capacity,
                    collapseAt: Math.min(
                      prefs.organize.collapseAt,
                      capacity - 1,
                    ),
                  },
                })
              }
            />
          }
        />
        <SettingRow
          label="Contraction threshold"
          description="A top-level topic with this many visible root threads or fewer, including completed threads, gets one workstream for all its subtopics."
          control={
            <Stepper
              label="Contraction threshold"
              value={prefs.organize.collapseAt}
              min={0}
              max={prefs.organize.capacity - 1}
              onChange={(collapseAt) => update({ organize: { collapseAt } })}
            />
          }
        />
      </SectionRows>
    </div>
  );
}

export function AdvancedSettings() {
  const { prefs, update, error } = useFeaturePrefs();
  const rpc = useRpc<RpcContract>();
  const [machines, setMachines] = useState<
    { id: string; name: string }[] | null
  >(null);
  useEffect(() => {
    let active = true;
    void rpc
      .call("machines", null)
      .then(({ machines: connected }) => {
        if (active) setMachines(connected);
      })
      .catch(() => {
        if (active) setMachines([]);
      });
    return () => {
      active = false;
    };
  }, [rpc]);
  if (!prefs) return <Loading />;
  const machineOptions = [
    { value: "", label: "Only connected machine" },
    ...(machines?.map((machine) => ({
      value: machine.id,
      label: machine.name,
    })) ?? []),
  ];
  return (
    <div className="space-y-3">
      <SettingsSaveError error={error} />
      <SectionRows>
        {machines && machines.length > 1 ? (
          <SettingRow
            label="Analysis machine"
            description="Machine whose Pi key is used for AI Gateway calls."
            control={
              <SettingsPicker
                label="Analysis machine"
                value={prefs.advanced.hostId}
                options={machineOptions}
                placeholder="Use any connected machine"
                onChange={(hostId) => update({ advanced: { hostId } })}
                className="w-56"
              />
            }
          />
        ) : null}
        <SettingRow
          label="Debug mode"
          description="Records prompts, reasoning, and responses with redacted thread excerpts. Kept for 7 days."
          control={
            <SettingSwitch
              label="Debug mode"
              checked={prefs.advanced.debug}
              onChange={(debug) => update({ advanced: { debug } })}
            />
          }
        />
      </SectionRows>
    </div>
  );
}

function SettingsSaveError({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;
}

function Loading() {
  return <p className="text-xs text-muted-foreground">Loading settings…</p>;
}
