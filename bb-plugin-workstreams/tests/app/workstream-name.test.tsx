// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  WorkstreamName,
  splitWorkstreamName,
} from "../../src/app/WorkstreamName.tsx";

afterEach(cleanup);

describe("WorkstreamName", () => {
  it("renders a plain name as is", () => {
    const { container } = render(<WorkstreamName name="Workstreams" />);
    expect(container.textContent).toBe("Workstreams");
  });

  it("shows an area's owner subdued and hides the colon visually", () => {
    const { container, getByText } = render(
      <WorkstreamName name="Workstreams: Recaps" />,
    );
    expect(getByText("Workstreams").className).toContain(
      "text-muted-foreground",
    );
    expect(getByText(":").className).toContain("sr-only");
    expect(container.textContent).toBe("Workstreams: Recaps");
  });

  it("treats a leading or trailing colon as a plain name", () => {
    expect(splitWorkstreamName(":test")).toBeNull();
    expect(splitWorkstreamName("test:")).toBeNull();
    expect(splitWorkstreamName("A: B")).toEqual({ owner: "A", area: "B" });
  });
});
