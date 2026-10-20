// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  CreateEntityDialog,
  EditMetadataDialog,
  RenameEntityDialog,
} from "../../src/app/page/CatalogDialogs.tsx";

afterEach(cleanup);
const topic = {
  id: "topic",
  name: "Example",
  parentId: null,
  description: "",
  aliases: [],
};

it("bounds topic name and description fields to their RPC limits", () => {
  const common = {
    rpc: { call: vi.fn() } as never,
    onSuccess: vi.fn(),
    onClose: vi.fn(),
  };
  const create = renderSlot(
    { component: CreateEntityDialog },
    { ...common, parentId: null, entities: [] },
  );
  let body = within(document.body);
  expect(body.getByLabelText("Name *").getAttribute("maxlength")).toBe("200");
  expect(body.getByLabelText("Description").getAttribute("maxlength")).toBe(
    "1000",
  );
  create.unmount();
  renderSlot({ component: RenameEntityDialog }, { ...common, entity: topic });
  body = within(document.body);
  expect(body.getByLabelText("Name *").getAttribute("maxlength")).toBe("200");
});

it.each(["create", "edit"] as const)(
  "explains oversized aliases before %s makes an RPC",
  async (mode) => {
    const call = vi.fn();
    const common = {
      rpc: { call } as never,
      onSuccess: vi.fn(),
      onClose: vi.fn(),
    };
    if (mode === "create") {
      renderSlot(
        { component: CreateEntityDialog },
        { ...common, parentId: null, entities: [] },
      );
      fireEvent.change(within(document.body).getByLabelText("Name *"), {
        target: { value: "Example" },
      });
    } else {
      renderSlot(
        { component: EditMetadataDialog },
        { ...common, entity: topic },
      );
    }
    const body = within(document.body);
    fireEvent.change(body.getByLabelText("Aliases"), {
      target: { value: "a".repeat(81) },
    });
    fireEvent.click(
      body.getByRole("button", {
        name: mode === "create" ? "Create" : "Save details",
      }),
    );
    expect(await body.findByRole("alert")).toHaveProperty(
      "textContent",
      "Keep each alias to 80 characters or fewer.",
    );
    expect(call).not.toHaveBeenCalled();
  },
);
