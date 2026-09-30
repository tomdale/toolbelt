import { describe, expect, it } from "vitest";
import {
  appliedCopy,
  pendingCopy,
  proposalKey,
  snoozeKey,
} from "../../src/domain/evolution.ts";

describe("shared proposal contract", () => {
  it("keeps stable action identities for snoozing and history", () => {
    const key = proposalKey("spin-out", "section-a", "Release engineering");
    expect(key).toBe("spin-out:section-a:releaseengineering");
    expect(snoozeKey(key)).toBe("section-a:releaseengineering");
    expect(proposalKey("move", "source", "section-target")).toBe(
      "move:source:section-target",
    );
    expect(proposalKey("merge", "source", "section-target")).toBe(
      "merge:source:section-target",
    );
  });

  it("preserves proposal and applied banner copy for every action kind", () => {
    expect(
      pendingCopy("spin-out", "Release engineering", 1, "Platform"),
    ).toEqual({
      text: "This thread and 1 other look like Release engineering work. Spin out a Release engineering workstream?",
      accept: "Spin out",
    });
    expect(
      pendingCopy("move", "Release engineering", 0, "Platform").accept,
    ).toBe("Move");
    expect(pendingCopy("merge", "Platform", 2, "Platform tools").accept).toBe(
      "Merge",
    );
    expect(appliedCopy("Platform", "Release engineering")).toBe(
      "Moved from Platform → Release engineering",
    );
  });
});
