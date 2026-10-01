// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { parsePrefs, mergePrefs } from "../../src/domain/prefs.ts";

afterEach(cleanup);

async function mount(
  sectionId: string,
  options: { machines?: { id: string; name: string }[] } = {},
) {
  let prefs = parsePrefs({});
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const section = app.settingsSections.find((entry) => entry.id === sectionId)!;
  const slot = await renderSlot(
    section,
    {},
    {
      settings: { debug: true },
      rpc: {
        prefs: () => ({ prefs }),
        setPrefs: (input: unknown) => {
          prefs = mergePrefs(
            prefs,
            (input as { patch: Parameters<typeof mergePrefs>[1] }).patch,
          );
          return { prefs };
        },
        machines: () => ({ machines: options.machines ?? [] }),
        spinner: () => ({
          spinner: { shape: "spokes", primary: "subtle", secondary: "auto" },
        }),
        setSpinner: (input: unknown) => input as { spinner: unknown },
      },
    },
  );
  return slot;
}

it("registers settings in feature order", async () => {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  expect(app.settingsSections.map(({ id, title }) => [id, title])).toEqual([
    ["sidebar", "Sidebar"],
    ["working-indicator", "Working Indicator"],
    ["threads", "Threads"],
    ["recap", "Recap"],
    ["snooze", "Snooze"],
    ["new-work", "New work"],
    ["organize", "Organize"],
    ["advanced", "Advanced"],
  ]);
});

it("renders compact working styles and accessible colored swatches", async () => {
  const slot = await mount("working-indicator");
  const styles = await slot.findByRole("radiogroup", {
    name: "Working indicator style",
  });
  expect(styles.querySelectorAll("input[type=radio]")).toHaveLength(7);
  expect(
    slot.getByText("How a working thread is marked in the sidebar."),
  ).toBeTruthy();
  for (const color of ["Green", "Blue"]) {
    const swatch = slot.getByRole("radio", { name: color });
    expect(swatch.parentElement?.getAttribute("title")).toBe(color);
  }
  expect(
    styles.parentElement?.querySelector('input[type="color"]'),
  ).toBeTruthy();
});

it("renders four compact sidebar toggles and saves their preferences", async () => {
  const slot = await mount("sidebar");
  for (const label of ["Up Next", "Recent", "Snoozed", "Archived"]) {
    expect(await slot.findByRole("switch", { name: label })).toBeTruthy();
  }
  const sections = slot.getByRole("region", { name: "Sections" });
  for (const label of ["Timestamp", "Thread count", "Waiting count"])
    expect(within(sections).queryByRole("button", { name: label })).toBeNull();
  fireEvent.click(slot.getByRole("switch", { name: "Snoozed" }));
  fireEvent.click(slot.getByRole("switch", { name: "Archived" }));
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "setPrefs"),
    ).toHaveLength(2),
  );
  expect(
    slot.inspection.rpcCalls
      .filter((call) => call.method === "setPrefs")
      .map((call) => call.input),
  ).toEqual([
    { patch: { sidebar: { showSnoozed: false } } },
    { patch: { sidebar: { showArchived: false } } },
  ]);
});

it("saves all three timestamp choices apart from section switches", async () => {
  const slot = await mount("sidebar");
  expect(
    within(await slot.findByRole("region", { name: "Threads" })).queryByRole(
      "switch",
    ),
  ).toBeNull();
  const picker = await slot.findByRole("button", { name: "Timestamp" });
  expect(picker.classList.contains("w-40")).toBe(true);
  expect(picker.parentElement?.classList.contains("shrink-0")).toBe(true);
  for (const [label, value] of [
    ["Only on hover", "hover"],
    ["Don't show", "hide"],
    ["Show", "show"],
  ]) {
    fireEvent.click(await slot.findByRole("button", { name: "Timestamp" }));
    fireEvent.click(await slot.findByRole("option", { name: label }));
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Timestamp" }).textContent).toBe(
        label,
      ),
    );
    expect(
      slot.inspection.rpcCalls
        .filter((call) => call.method === "setPrefs")
        .at(-1)?.input,
    ).toEqual({ patch: { sidebar: { timestamps: value } } });
  }
});

it.each([
  ["Thread count", "threadCount"],
  ["Waiting count", "waitingCount"],
])("saves %s visibility", async (label, key) => {
  const slot = await mount("sidebar");
  const headers = await slot.findByRole("region", { name: "Workstreams" });
  for (const [option, value] of [
    ["Always", "always"],
    ["Never", "never"],
    ["When collapsed", "collapsed"],
  ]) {
    fireEvent.click(within(headers).getByRole("button", { name: label }));
    fireEvent.click(await slot.findByRole("option", { name: option }));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls
          .filter((call) => call.method === "setPrefs")
          .at(-1)?.input,
      ).toEqual({ patch: { sidebar: { [key]: value } } }),
    );
  }
});

it("clamps the Recent stepper to 1–20 and hides it when Recent is off", async () => {
  const slot = await mount("sidebar");
  const recent = await slot.findByRole("switch", { name: "Recent" });
  const plus = slot.getByRole("button", { name: "Increase threads shown" });
  for (let index = 0; index < 30; index++) fireEvent.click(plus);
  await waitFor(() =>
    expect(
      slot.getByLabelText("threads shown", { selector: "output" }).textContent,
    ).toBe("20"),
  );
  expect(plus).toHaveProperty("disabled", true);
  fireEvent.click(recent);
  await waitFor(() =>
    expect(
      slot.queryByRole("button", { name: "Increase threads shown" }),
    ).toBeNull(),
  );
  expect(
    slot.inspection.rpcCalls.some(
      (call) =>
        call.method === "setPrefs" &&
        JSON.stringify(call.input).includes('"showRecent":false'),
    ),
  ).toBe(true);
});

it("saves the Titles and parent-link switches", async () => {
  const slot = await mount("threads");
  fireEvent.click(
    await slot.findByRole("switch", { name: "Keep titles current" }),
  );
  fireEvent.click(
    slot.getByRole("switch", { name: "Show parent thread link" }),
  );
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "setPrefs"),
    ).toHaveLength(2),
  );
  expect(
    slot.inspection.rpcCalls
      .filter((call) => call.method === "setPrefs")
      .map((call) => call.input),
  ).toEqual([
    { patch: { threads: { autoTitle: false } } },
    { patch: { threads: { showParentLink: true } } },
  ]);
  expect(slot.getByTestId("bb-provider-model-picker")).toBeTruthy();
});

it("saves New work preferences and disables the suggestions model when suggestions are off", async () => {
  const slot = await mount("new-work");
  await slot.findByRole("switch", { name: "Suggestions while typing" });
  expect(
    slot.getByText("Suggests a workstream for a new-thread draft as you type."),
  ).toBeTruthy();
  expect(
    slot.getByText("Suggests a workstream for a new-thread draft as you type."),
  ).toBeTruthy();
  fireEvent.click(await slot.findByRole("button", { name: "Home project" }));
  fireEvent.click(
    await slot.findByRole("option", { name: "Don't work in a project" }),
  );
  fireEvent.click(
    slot.getByRole("switch", { name: "Suggestions while typing" }),
  );
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "setPrefs"),
    ).toHaveLength(2),
  );
  expect(
    slot.inspection.rpcCalls
      .filter((call) => call.method === "setPrefs")
      .map((call) => call.input),
  ).toEqual([
    { patch: { newWork: { homeProjectId: "" } } },
    { patch: { newWork: { suggestions: false } } },
  ]);
  expect(
    slot.getByTestId("bb-provider-model-picker").getAttribute("data-disabled"),
  ).toBe("true");
});

it("shows the worker-thread note for a non-gateway analysis model", async () => {
  const slot = await mount("threads");
  await slot.findByTestId("bb-provider-model-picker");
  expect(
    slot.queryByText(/hidden worker thread and takes several seconds longer/i),
  ).toBeNull();
  const model = slot.getByLabelText("Model") as HTMLInputElement;
  const provider = slot.getByLabelText("Provider ID") as HTMLInputElement;
  fireEvent.change(provider, { target: { value: "openai" } });
  fireEvent.change(model, { target: { value: "gpt-4.1" } });
  fireEvent.click(
    slot.getByRole("button", { name: "Apply execution selection" }),
  );
  await waitFor(() =>
    expect(
      slot.getByText(/hidden worker thread and takes several seconds longer/i),
    ).toBeTruthy(),
  );
});

it("saves the organizing model selection", async () => {
  const slot = await mount("organize");
  const picker = await slot.findByTestId("bb-provider-model-picker");
  expect(picker).toBeTruthy();
  expect(
    (picker.querySelector('[aria-label="Model"]') as HTMLInputElement).value,
  ).toBe("vercel-ai-gateway/openai/gpt-6-sol-fast");
});

it("shows the Analysis machine only when more than one machine is connected", async () => {
  const alone = await mount("advanced", {
    machines: [{ id: "m1", name: "Laptop" }],
  });
  await alone.findByRole("switch", { name: "Debug mode" });
  expect(alone.queryByRole("button", { name: "Analysis machine" })).toBeNull();
  alone.lifecycle.unmount();
  const several = await mount("advanced", {
    machines: [
      { id: "m1", name: "Laptop" },
      { id: "m2", name: "Studio" },
    ],
  });
  expect(
    await several.findByRole("button", { name: "Analysis machine" }),
  ).toBeTruthy();
  fireEvent.click(several.getByRole("switch", { name: "Debug mode" }));
  await waitFor(() =>
    expect(
      several.inspection.rpcCalls.some(
        (call) =>
          call.method === "setPrefs" &&
          JSON.stringify(call.input).includes('"debug":true'),
      ),
    ).toBe(true),
  );
});
