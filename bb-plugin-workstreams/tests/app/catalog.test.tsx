// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Catalog } from "../../src/app/page/Catalog.tsx";
afterEach(cleanup);
const entries = [
  {
    id: "p",
    name: "Lantern",
    description: "Product",
    parentId: null,
    aliases: [],
  },
  {
    id: "f",
    name: "Shelves",
    description: "Share collections",
    parentId: "p",
    aliases: ["Storage"],
  },
];
it("shows all known entries and filters inactive features by alias and scope", async () => {
  const call = vi.fn(async () => ({ entities: entries }));
  render(<Catalog rpc={{ call } as never} />);
  expect(await screen.findByText("Shelves")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search products and features"), {
    target: { value: "Storage" },
  });
  expect(screen.getByText("Shelves").getAttribute("title")).toBe(
    "Lantern: Shelves",
  );
  expect(screen.getByText("Lantern", { selector: "h3" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search products and features"), {
    target: { value: "unknown" },
  });
  expect(screen.getByText("No matching products or features")).toBeTruthy();
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith("corpus", null);
});
it("reports a load failure and allows retry", async () => {
  const call = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue({ entities: [] });
  render(<Catalog rpc={{ call } as never} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Offline");
  fireEvent.click(screen.getByText("Retry"));
  expect(
    await screen.findByText("No products or features have been recorded yet"),
  ).toBeTruthy();
});
