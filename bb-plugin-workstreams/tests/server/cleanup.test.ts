import { expect, it } from "vitest";
import {
  ARCHIVE_GRACE_MS,
  cleanupCandidate,
} from "../../src/server/cleanup.ts";

const section = { id: "s", name: "Old work" };
it("uses the newest archive timestamp, strictly older than 24 hours", () => {
  const now = 100 * ARCHIVE_GRACE_MS;
  const member = (id: string, archivedAt: number | null) => ({
    id,
    archivedAt,
    sectionId: "s",
  });
  expect(cleanupCandidate(section, [], now)).not.toBeNull();
  expect(cleanupCandidate(section, [member("t", null)], now)).toBeNull();
  expect(
    cleanupCandidate(section, [member("t", now - ARCHIVE_GRACE_MS)], now),
  ).toBeNull();
  expect(
    cleanupCandidate(section, [member("t", now - ARCHIVE_GRACE_MS - 1)], now),
  ).not.toBeNull();
  expect(
    cleanupCandidate(
      section,
      [member("old", 1), member("recent", now - 1000)],
      now,
    ),
  ).toBeNull();
});
