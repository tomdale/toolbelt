// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { WorkstreamName } from "../../src/app/WorkstreamName.tsx";

afterEach(cleanup);

describe("WorkstreamName", () => {
  it("renders a standard name normally", () => {
    const { container } = render(<WorkstreamName name="Workstreams" />);
    expect(container.textContent).toBe("Workstreams");
  });

  it("renders colon-prefixed sub-areas with distinct product and area styling", () => {
    const { container, getByText } = render(
      <WorkstreamName name="Workstreams: Core" />,
    );
    expect(container.textContent).toBe("Workstreams:Core");
    const prefix = getByText("Workstreams");
    const suffix = getByText("Core");
    expect(prefix.className).toContain("text-muted-foreground");
    expect(suffix.className).toContain("font-semibold");
  });

  it("handles names with colons at the ends gracefully", () => {
    const { container } = render(<WorkstreamName name=":test" />);
    expect(container.textContent).toBe(":test");
  });
});
