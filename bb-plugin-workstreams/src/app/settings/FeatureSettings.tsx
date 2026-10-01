import { useEffect, useState, type ReactNode } from "react";
import { experimental_useSidebarThreads, useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import { RECENT_LIMIT, type PrefsPatch } from "../../domain/prefs.ts";
import { ModelField } from "./ModelField.tsx";
import {
  CompactSettingRow,
  SectionRows,
  SettingRow,
  SettingSwitch,
  SettingsPicker,
  Stepper,
} from "./ui.tsx";

function useFeaturePrefs() {
  const { prefs, save } = usePrefs();
  const update = (patch: PrefsPatch) => void save(patch).catch(() => {});
  return { prefs, update };
}

import { usePrefs } from "../prefs.ts";

export function SidebarSettings() {
  const { prefs, update } = useFeaturePrefs();
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
  return (
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
  );
}

export function TimestampSettings() {
  const { prefs, update } = useFeaturePrefs();
  if (!prefs) return <Loading />;
  return (
    <SectionRows>
      <SettingRow
        label="Show timestamp"
        control={
          <SettingsPicker
            label="Timestamp"
            value={prefs.sidebar.timestamps}
            className="w-40"
            options={[
              { value: "show", label: "Show" },
              { value: "hover", label: "Only on hover" },
              { value: "hide", label: "Don't show" },
            ]}
            onChange={(timestamps) => {
              if (
                timestamps === "show" ||
                timestamps === "hover" ||
                timestamps === "hide"
              )
                update({ sidebar: { timestamps } });
            }}
          />
        }
      />
    </SectionRows>
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
  const { prefs, update } = useFeaturePrefs();
  if (!prefs) return <Loading />;
  return (
    <SectionRows>
      <ModelField
        label="Analysis model"
        description={
          prefs.threads.autoTitle
            ? "Summarizes each thread after every turn for the sidebar, and writes titles while Keep titles current is on."
            : "Summarizes each thread after every turn for the sidebar."
        }
        choice={prefs.threads.analysisModel}
        onChange={(analysisModel) => update({ threads: { analysisModel } })}
      />
      <SettingRow
        label="Keep titles current"
        description="Write and update thread titles as work progresses."
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
    </SectionRows>
  );
}

export function NewWorkSettings() {
  const { prefs, update } = useFeaturePrefs();
  const { status, projects } = experimental_useSidebarThreads();
  if (!prefs) return <Loading />;
  const projectOptions = [
    { value: "", label: "Don't work in a project" },
    ...projects
      .filter((project) => !project.isPersonal)
      .map((project) => ({ value: project.id, label: project.name })),
  ];
  return (
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
            onChange={(homeProjectId) => update({ newWork: { homeProjectId } })}
            disabled={status !== "ready"}
            className="w-56"
          />
        }
      />
      <SettingRow
        label="Suggestions while typing"
        description="Suggest a workstream for a new thread as you write."
        control={
          <SettingSwitch
            label="Suggestions while typing"
            checked={prefs.newWork.suggestions}
            onChange={(suggestions) => update({ newWork: { suggestions } })}
          />
        }
      />
      <ModelField
        label="Suggestions model"
        description="Suggests a workstream for a new-thread draft as you type."
        choice={prefs.newWork.suggestionsModel}
        disabled={!prefs.newWork.suggestions}
        onChange={(suggestionsModel) =>
          update({ newWork: { suggestionsModel } })
        }
      />
    </SectionRows>
  );
}

export function OrganizeSettings() {
  const { prefs, update } = useFeaturePrefs();
  if (!prefs) return <Loading />;
  return (
    <SectionRows>
      <ModelField
        label="Organizing model"
        description="Proposes the workstream map when you click Organize."
        choice={prefs.organize.model}
        onChange={(model) => update({ organize: { model } })}
      />
    </SectionRows>
  );
}

export function AdvancedSettings() {
  const { prefs, update } = useFeaturePrefs();
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
  );
}

function Loading() {
  return <p className="text-xs text-muted-foreground">Loading settings…</p>;
}

import { SpinnerSettings } from "./SpinnerSettings.tsx";
