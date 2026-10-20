// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { CustomSnoozeDialog } from "../../src/app/snooze/CustomSnoozeDialog.tsx";

describe("CustomSnoozeDialog", () => {
  beforeEach(() => {
    installTestPluginRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T18:30:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("opens on tomorrow morning using the configured hour", () => {
    render(
      <CustomSnoozeDialog
        open
        onClose={() => undefined}
        onSubmit={() => undefined}
        morningHour={7}
      />,
    );

    expect((screen.getByLabelText("Wake time") as HTMLInputElement).value).toBe(
      "2025-01-16T07:00",
    );
  });

  it("uses current time for the maximum when an open dialog is edited later", () => {
    const onSubmit = vi.fn();
    render(
      <CustomSnoozeDialog
        open
        onClose={() => undefined}
        onSubmit={onSubmit}
        morningHour={9}
      />,
    );
    vi.setSystemTime(new Date("2025-01-17T18:30:00"));
    fireEvent.change(screen.getByLabelText("Wake time"), {
      target: { value: "2026-01-17T12:00" },
    });
    const button = screen.getByRole("button", { name: "Snooze" });
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledWith(
      new Date("2026-01-17T12:00").getTime(),
    );
  });

  it("rechecks a formerly future wake time when submitting a long-lived form", () => {
    const onSubmit = vi.fn();
    render(
      <CustomSnoozeDialog
        open
        onClose={() => undefined}
        onSubmit={onSubmit}
        morningHour={9}
      />,
    );
    vi.setSystemTime(new Date("2025-01-17T18:30:00"));
    fireEvent.submit(
      screen.getByRole("button", { name: "Snooze" }).closest("form")!,
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks dates beyond the server snooze window in the client", () => {
    render(
      <CustomSnoozeDialog
        open
        onClose={() => undefined}
        onSubmit={() => undefined}
        morningHour={9}
      />,
    );

    fireEvent.change(screen.getByLabelText("Wake time"), {
      target: { value: "2026-02-01T09:00" },
    });

    expect(screen.getByText("Pick a time in the next year.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Snooze" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
