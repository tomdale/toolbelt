// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { NewWorkDialog } from "../../src/app/composer/NewWork.tsx";
import type { RouteDecision } from "../../src/server/router.ts";
import { emptyState } from "./fixtures.ts";

afterEach(cleanup);

const decision: RouteDecision = {
  id: "d1",
  outcome: "new-thread",
  sectionId: "sec_a",
  workstream: "Alpha",
  title: "Fix parser",
  confidence: "high",
  reason: "",
  subject: null,
  traceId: null,
  placement: {
    projectId: "proj_a",
    environment: { type: "project-default" },
    label: "checkout",
  },
};

it("sends to the chosen workstream without classifying and closes from its header", async () => {
  const onClose = vi.fn();
  const slot = renderSlot(
    { component: NewWorkDialog },
    { open: true, onClose, workstreamId: "sec_a", workstreamName: "Alpha" },
    {
      rpc: {
        state: () => emptyState(),
        route: () => decision,
        routeExecute: () => ({ threadId: "thr_new" }),
      },
    },
  );
  const composer = screen.getByTestId("bb-new-thread-composer");
  // A contained composer fills the dialog's grid row and pushes the rest out.
  expect(composer.dataset.layout).toBe("document");
  fireEvent.change(screen.getByTestId("bb-new-thread-composer-input"), {
    target: { value: "Fix the parser" },
  });
  fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
  const [route, execute] = slot.inspection.rpcCalls;
  expect(route).toMatchObject({
    method: "route",
    input: { prompt: "Fix the parser", workstreamId: "sec_a" },
  });
  expect(execute).toMatchObject({
    method: "routeExecute",
    input: { decisionId: "d1", prompt: "Fix the parser", choice: null },
  });
  expect(onClose).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(2);
});
