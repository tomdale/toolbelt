// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Reclassification } from "../../src/app/page/Reclassification.tsx";
afterEach(cleanup);
it("shows a read-only preview before an explicit apply and reports skipped corrections", async () => {
  const applied = vi.fn();
  const call = vi.fn(async (method: string) =>
    method === "reclassificationPreview"
      ? {
          id: "plan",
          at: 1,
          definitionKey: "catalog",
          rows: [
            {
              threadId: "t",
              title: "Pipeline audit",
              from: "Alpha",
              to: "Beta",
              error: null,
            },
          ],
        }
      : { changed: 0, skipped: 1 },
  );
  render(
    <Reclassification
      rpc={{ call } as never}
      threadIds={["t"]}
      onApplied={applied}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Preview topic repairs" }),
  );
  await screen.findByText("Pipeline audit: Alpha → Beta");
  expect(screen.getByRole("status").textContent).toContain(
    "1 topic proposals ready for review",
  );
  expect(call).toHaveBeenCalledTimes(1);
  expect(applied).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply topic repairs" }));
  await screen.findByText(/0 topics changed; 1 skipped/);
  expect(call).toHaveBeenLastCalledWith("reclassificationApply", {
    planId: "plan",
  });
  expect(applied).toHaveBeenCalledOnce();
});
