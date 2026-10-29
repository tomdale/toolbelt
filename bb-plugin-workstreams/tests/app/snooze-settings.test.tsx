// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyState } from "./fixtures.ts";
import {
  DEFAULT_SNOOZE_PREFS,
  type SnoozePreset,
  type SnoozePrefs,
} from "../../src/domain/snooze.ts";

afterEach(cleanup);

async function mount(
  initial: SnoozePrefs = DEFAULT_SNOOZE_PREFS,
  { failRead = false } = {},
) {
  let prefs = initial;
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const section = app.settingsSections.find((s) => s.id === "snooze")!;
  return renderSlot(
    section,
    {},
    {
      rpc: {
        state: () => {
          if (failRead) throw new Error("offline");
          return { ...emptyState(), snoozes: {}, snoozePrefs: prefs };
        },
        setSnoozePrefs: (input: unknown) => {
          prefs = { ...prefs, ...(input as { patch: object }).patch };
          return { prefs };
        },
      },
    },
  );
}

type Slot = Awaited<ReturnType<typeof mount>>;
const lastPatch = (slot: Slot) =>
  (
    slot.inspection.rpcCalls.filter((c) => c.method === "setSnoozePrefs").at(-1)
      ?.input as { patch: Partial<SnoozePrefs> } | undefined
  )?.patch;
const ids = (presets: readonly SnoozePreset[] | undefined) =>
  presets?.map((p) => p.id);
const rows = (slot: Slot) =>
  within(slot.getByRole("list", { name: "Snooze presets" }))
    .getAllByRole("listitem")
    .map((row) => row.querySelector("p")!.textContent);

it("lists the presets in menu order with the default chosen", async () => {
  const slot = await mount();
  await waitFor(() =>
    expect(rows(slot)).toEqual([
      "1 hour",
      "Tomorrow morning",
      "Next week",
      "Until it updates",
    ]),
  );
  expect(
    slot.getByRole("radio", { name: "Default: Tomorrow morning" }),
  ).toHaveProperty("checked", true);
  expect(slot.getByText("4 of 6")).toBeTruthy();
  fireEvent.click(slot.getByRole("radio", { name: "Default: Next week" }));
  await waitFor(() =>
    expect(lastPatch(slot)).toEqual({ default: "next-week" }),
  );
});

it("adds a preset with its own label", async () => {
  const slot = await mount();
  fireEvent.click(await slot.findByRole("button", { name: "Add preset" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("radio", { name: "Time" }));
  fireEvent.change(within(dialog).getByLabelText("Day"), {
    target: { value: "today" },
  });
  fireEvent.change(within(dialog).getByLabelText("Time of day"), {
    target: { value: "18:00" },
  });
  expect(
    (within(dialog).getByLabelText("Label") as HTMLInputElement).placeholder,
  ).toMatch(/^Today at 6/);
  fireEvent.change(within(dialog).getByLabelText("Label"), {
    target: { value: "  This evening " },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  await waitFor(() => expect(lastPatch(slot)?.presets).toHaveLength(5));
  const added = lastPatch(slot)!.presets!.at(-1)!;
  expect(added).toMatchObject({
    label: "This evening",
    rule: { kind: "time", day: "today", hour: 18, minute: 0 },
  });
  expect(DEFAULT_SNOOZE_PREFS.presets.map((p) => p.id)).not.toContain(added.id);
  await waitFor(() => expect(rows(slot).at(-1)).toBe("This evening"));
});

it("edits a preset, keeping its place and id", async () => {
  const slot = await mount();
  fireEvent.click(await slot.findByRole("button", { name: "Edit 1 hour" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    (within(dialog).getByLabelText("Amount") as HTMLInputElement).value,
  ).toBe("1");
  fireEvent.change(within(dialog).getByLabelText("Amount"), {
    target: { value: "2" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(lastPatch(slot)?.presets?.[0]).toEqual({
      id: "1h",
      label: "",
      rule: { kind: "duration", amount: 2, unit: "hours" },
    }),
  );
});

it("reorders presets from the keyboard, keeping focus on the moved one", async () => {
  const slot = await mount();
  const handle = await slot.findByRole("button", { name: "Move 1 hour" });
  handle.focus();
  fireEvent.keyDown(handle, { key: "ArrowDown" });
  await waitFor(() =>
    expect(ids(lastPatch(slot)?.presets)).toEqual([
      "tomorrow",
      "1h",
      "next-week",
      "activity",
    ]),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      slot.getByRole("button", { name: "Move 1 hour" }),
    ),
  );
  expect(slot.getByText("1 hour moved to position 2 of 4.")).toBeTruthy();
  // The list doesn't wrap: Up from the top does nothing.
  const calls = slot.inspection.rpcCalls.length;
  fireEvent.keyDown(
    slot.getByRole("button", { name: "Move Tomorrow morning" }),
    {
      key: "ArrowUp",
    },
  );
  expect(slot.inspection.rpcCalls.length).toBe(calls);
});

it("waits for the stored presets before offering edits", async () => {
  const slot = await mount(DEFAULT_SNOOZE_PREFS, { failRead: true });
  expect(
    await slot.findByText("Couldn't load your snooze presets."),
  ).toBeTruthy();
  expect(slot.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(slot.queryByRole("list", { name: "Snooze presets" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Add preset" })).toBeNull();
});

it("moves the default to the first preset when it is deleted", async () => {
  const slot = await mount();
  const remove = await slot.findByRole("button", {
    name: "Delete Tomorrow morning",
  });
  remove.focus();
  fireEvent.click(remove);
  await waitFor(() =>
    expect(lastPatch(slot)).toEqual({
      presets: DEFAULT_SNOOZE_PREFS.presets.filter((p) => p.id !== "tomorrow"),
      default: "1h",
    }),
  );
  await waitFor(() =>
    expect(slot.getByRole("radio", { name: "Default: 1 hour" })).toHaveProperty(
      "checked",
      true,
    ),
  );
});

it("keeps the last preset, and stops adding at six", async () => {
  const only: SnoozePrefs = {
    presets: [DEFAULT_SNOOZE_PREFS.presets[0]!],
    default: "1h",
  };
  const slot = await mount(only);
  const remove = await slot.findByRole("button", { name: "Delete 1 hour" });
  expect(remove.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(remove);
  expect(
    slot.inspection.rpcCalls.filter((c) => c.method === "setSnoozePrefs"),
  ).toEqual([]);
  slot.lifecycle.unmount();

  const six: SnoozePrefs = {
    presets: Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      label: `Preset ${i}`,
      rule: { kind: "duration", amount: i + 1, unit: "hours" },
    })),
    default: "p0",
  };
  const full = await mount(six);
  const add = await full.findByRole("button", { name: "Add preset" });
  expect(add.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(add);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    full
      .getByRole("button", { name: "Delete Preset 0" })
      .getAttribute("aria-disabled"),
  ).toBe("false");
});
