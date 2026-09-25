import { afterEach, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { execFile } from "node:child_process";
import hostEntry, { inferenceArgs } from "../host";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("sends excerpts over stdin to the fixed tool-free Pi command", async () => {
  const end = vi.fn();
  vi.mocked(execFile).mockImplementation(((
    command: string,
    args: string[],
    options: any,
    callback: any,
  ) => {
    expect(command).toBe("pi");
    expect(args).toEqual(inferenceArgs);
    expect(args.join(" ")).not.toContain("private excerpt");
    expect(options.timeout).toBe(120_000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    queueMicrotask(() =>
      callback(
        null,
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: '{"items":[]}' }],
            usage: { input: 10, output: 2, cost: { total: 0.01 } },
          },
        }) + "\n",
      ),
    );
    return { stdin: { end, on: vi.fn() } };
  }) as any);
  const h = experimental_createHostEntryHarness(hostEntry);
  try {
    expect(
      await h.experimental_call("complete", { prompt: "private excerpt" }),
    ).toEqual({
      text: '{"items":[]}',
      usage: { input: 10, output: 2, cost: 0.01 },
    });
    expect(end).toHaveBeenCalledWith("private excerpt");
  } finally {
    await h.experimental_dispose();
  }
});

it("reports provider errors without leaking subprocess stderr or falling back", async () => {
  vi.mocked(execFile).mockImplementation(((
    command: string,
    args: string[],
    options: any,
    callback: any,
  ) => {
    queueMicrotask(() => callback(new Error("private diagnostics"), ""));
    return { stdin: { end: vi.fn(), on: vi.fn() } };
  }) as any);
  const h = experimental_createHostEntryHarness(hostEntry);
  try {
    await expect(
      h.experimental_call("complete", { prompt: "classify" }),
    ).rejects.toThrow(/No fallback/);
    expect(execFile).toHaveBeenCalledTimes(1);
  } finally {
    await h.experimental_dispose();
  }
});
