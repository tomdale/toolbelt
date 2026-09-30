// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(cleanup);

const spokes = { shape: "spokes", primary: "subtle", secondary: "auto" };

async function mount(stored: unknown = spokes, load?: Promise<unknown>) {
  const app = await loadPluginApp(() => import("../../src/app/index.tsx"));
  const section = app.settingsSections.find((s) => s.id === "spinner")!;
  return renderSlot(
    section,
    {},
    {
      rpc: {
        spinner: async () => ({ spinner: load ? await load : stored }),
        setSpinner: (raw: unknown) => raw as { spinner: unknown },
      },
    },
  );
}

type Slot = Awaited<ReturnType<typeof mount>>;
const group = (slot: Slot, name: string) =>
  within(slot.getByRole("group", { name }));
const checked = (slot: Slot, groupName: string, name: RegExp | string) =>
  (group(slot, groupName).getByRole("radio", { name }) as HTMLInputElement)
    .checked;
const lastSave = (slot: Slot) =>
  slot.inspection.rpcCalls.filter((c) => c.method === "setSpinner").at(-1);

describe("working indicator settings", () => {
  it("draws every shape live and checks the stored style", async () => {
    const slot = await mount({
      shape: "orbit",
      primary: "green",
      secondary: "auto",
    });
    const shapes = group(slot, "Animation").getAllByRole("radio");
    expect(shapes).toHaveLength(7);
    await waitFor(() => expect(checked(slot, "Animation", /Orbit/)).toBe(true));
    expect(checked(slot, "Color", "Green")).toBe(true);
    expect(slot.container.querySelectorAll(".ws-spin")).toHaveLength(7);
    slot.lifecycle.unmount();
  });

  it("enables the track color only for shapes that draw a track", async () => {
    const slot = await mount();
    await waitFor(() =>
      expect(checked(slot, "Animation", /Spokes/)).toBe(true),
    );
    expect(slot.getByRole("group", { name: "Track" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(
      group(slot, "Animation").getByRole("radio", { name: /Arc/ }),
    );
    fireEvent.click(
      group(slot, "Track").getByRole("radio", { name: "No track" }),
    );
    await waitFor(() =>
      expect(lastSave(slot)?.input).toEqual({
        spinner: { shape: "arc", primary: "subtle", secondary: "none" },
      }),
    );
    slot.lifecycle.unmount();
  });

  it("keeps both of two picks made before a re-render", async () => {
    const slot = await mount();
    await waitFor(() =>
      expect(checked(slot, "Animation", /Spokes/)).toBe(true),
    );
    const orbit = group(slot, "Animation").getByRole("radio", {
      name: /Orbit/,
    });
    const blue = group(slot, "Color").getByRole("radio", { name: "Blue" });
    act(() => {
      orbit.click();
      blue.click();
    });
    await waitFor(() =>
      expect(lastSave(slot)?.input).toEqual({
        spinner: { shape: "orbit", primary: "blue", secondary: "auto" },
      }),
    );
    slot.lifecycle.unmount();
  });

  it("keeps a pick made while the stored style is still loading", async () => {
    let finish!: (value: unknown) => void;
    const slot = await mount(
      undefined,
      new Promise((resolve) => (finish = resolve)),
    );
    fireEvent.click(
      group(slot, "Animation").getByRole("radio", { name: /Orbit/ }),
    );
    await act(async () =>
      finish({ shape: "ring", primary: "green", secondary: "none" }),
    );
    expect(checked(slot, "Animation", /Orbit/)).toBe(true);
    await waitFor(() =>
      expect(lastSave(slot)?.input).toEqual({
        spinner: { shape: "orbit", primary: "subtle", secondary: "auto" },
      }),
    );
    slot.lifecycle.unmount();
  });

  it("recolors every preview and saves a custom color once", async () => {
    const slot = await mount();
    await waitFor(() =>
      expect(checked(slot, "Animation", /Spokes/)).toBe(true),
    );
    const custom = group(slot, "Color").getByLabelText("Custom color");
    fireEvent.input(custom, { target: { value: "#112233" } });
    fireEvent.input(custom, { target: { value: "#445566" } });
    const previews = [
      ...slot.container.querySelectorAll<HTMLElement>(".ws-spin"),
    ];
    expect(
      previews.every(
        (mark) =>
          mark.style.getPropertyValue("--ws-spin-primary") === "#445566",
      ),
    ).toBe(true);
    await waitFor(() =>
      expect(lastSave(slot)?.input).toEqual({
        spinner: { shape: "spokes", primary: "#445566", secondary: "auto" },
      }),
    );
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "setSpinner"),
    ).toHaveLength(1);
    slot.lifecycle.unmount();
  });
});
