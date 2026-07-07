import type { SessionRecord } from "./types.js";

export function formatTable(records: SessionRecord[]): string {
  if (records.length === 0) {
    return "No sessions found.";
  }

  const rows = records.map((record) => ({
    provider: record.provider,
    updated: formatDate(record.updatedAt ?? record.createdAt),
    title: truncate(record.title, 58),
    id: record.id,
  }));

  const widths = {
    provider: Math.max("Agent".length, ...rows.map((row) => row.provider.length)),
    updated: Math.max("Updated".length, ...rows.map((row) => row.updated.length)),
    title: Math.max("Title".length, ...rows.map((row) => row.title.length)),
  };

  const header = [
    pad("Agent", widths.provider),
    pad("Updated", widths.updated),
    pad("Title", widths.title),
    "ID",
  ].join("  ");

  const body = rows.map((row) =>
    [
      pad(row.provider, widths.provider),
      pad(row.updated, widths.updated),
      pad(row.title, widths.title),
      row.id,
    ].join("  "),
  );

  return [header, ...body].join("\n");
}

export function serializeRecords(records: SessionRecord[]): unknown[] {
  return records.map((record) => ({
    ...record,
    createdAt: record.createdAt?.toISOString(),
    updatedAt: record.updatedAt?.toISOString(),
  }));
}

function formatDate(value: Date | undefined): string {
  if (!value) {
    return "-";
  }

  return value.toISOString().replace("T", " ").slice(0, 16);
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  return `${value.slice(0, Math.max(0, width - 1))}…`;
}
