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

  it("opens a date on tomorrow at 9 AM", () => {
    render(
      <CustomSnoozeDialog
        open
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect((screen.getByLabelText("Wake time") as HTMLInputElement).value).toBe(
      "2025-01-16T09:00",
    );
  });

  it("snoozes for a duration or until a time, judged on submit", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <CustomSnoozeDialog
        open
        kind="duration"
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "45" },
    });
    fireEvent.change(screen.getByLabelText("Unit"), {
      target: { value: "minutes" },
    });
    expect(screen.getByText(/^Returns to the sidebar until 7:15/)).toBeTruthy();
    vi.setSystemTime(new Date("2025-01-15T18:40:00"));
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
    expect(onSubmit).toHaveBeenLastCalledWith(
      new Date("2025-01-15T19:25:00").getTime(),
    );

    rerender(
      <CustomSnoozeDialog
        open={false}
        kind="time"
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    rerender(
      <CustomSnoozeDialog
        open
        kind="time"
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "workday" },
    });
    fireEvent.change(screen.getByLabelText("Time of day"), {
      target: { value: "08:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
    // Wednesday's next workday is Thursday.
    expect(onSubmit).toHaveBeenLastCalledWith(
      new Date("2025-01-16T08:30:00").getTime(),
    );
  });

  it("asks for a usable duration", () => {
    render(
      <CustomSnoozeDialog
        open
        kind="duration"
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "0" },
    });
    expect(screen.getByText("Enter how long to snooze.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Unit"), {
      target: { value: "days" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "400" },
    });
    expect(screen.getByText("Snooze for at most 365 days.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Snooze" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("uses current time for the maximum when an open dialog is edited later", () => {
    const onSubmit = vi.fn();
    render(
      <CustomSnoozeDialog open onClose={() => undefined} onSubmit={onSubmit} />,
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
      <CustomSnoozeDialog open onClose={() => undefined} onSubmit={onSubmit} />,
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
