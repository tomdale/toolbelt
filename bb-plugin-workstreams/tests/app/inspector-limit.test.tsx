// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { TraceInspector } from "../../src/app/debug/Inspector.tsx";

afterEach(cleanup);

it("discloses truncated thread history without reporting the slice as a total", async () => {
  const traces = Array.from({ length: 201 }, (_, i) => ({
    id: `trace-${i}`,
    at: i,
    kind: "quick-analysis",
    status: "ok",
    label: `Call ${i}`,
    model: "test/model",
    durationMs: 1,
    replayOf: null,
    usage: null,
    error: null,
    summary: null,
    threads: [],
  }));
  const slot = renderSlot(
    { component: TraceInspector },
    {
      open: true,
      onOpenChange: () => {},
      target: { link: { kind: "thread" as const, ref: "t1" } },
      title: "Thread calls",
    },
    {
      rpc: {
        traces: () => ({ traces }),
        trace: () => ({ trace: null }),
      } as never,
    },
  );
  const body = within(document.body);
  expect(
    await body.findByText(
      "200 model calls shown · history truncated; browse Activity for more",
    ),
  ).toBeTruthy();
  expect(body.queryByRole("button", { name: /Call 200/ })).toBeNull();
  expect(
    slot.inspection.rpcCalls.find((call) => call.method === "traces")?.input,
  ).toEqual({ link: { kind: "thread", ref: "t1" }, limit: 201 });
});
