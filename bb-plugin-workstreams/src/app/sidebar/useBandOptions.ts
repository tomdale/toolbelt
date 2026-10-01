import { useCallback, useEffect, useState } from "react";

export type BandId = "recent" | "snoozed" | "archived";
export type BandSort = "activity" | "title" | "wake" | "archived";
export type BandSortOption = readonly [BandSort, string];
export type BandOptions = Record<BandId, { sort: BandSort; grouped: boolean }>;

export const BAND_OPTIONS_KEY = "workstreams:v1:band-options";
export const DEFAULT_BAND_OPTIONS: BandOptions = {
  recent: { sort: "activity", grouped: false },
  snoozed: { sort: "wake", grouped: false },
  archived: { sort: "archived", grouped: true },
};

function validSort(id: BandId, value: string): value is BandSort {
  return (
    (id === "recent" && (value === "activity" || value === "title")) ||
    (id === "snoozed" &&
      (value === "wake" || value === "activity" || value === "title")) ||
    (id === "archived" &&
      (value === "archived" || value === "activity" || value === "title"))
  );
}

export function readBandOptions(): BandOptions {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(BAND_OPTIONS_KEY) ?? "{}",
    ) as Partial<Record<BandId, { sort?: string; grouped?: boolean }>>;
    return Object.fromEntries(
      (Object.keys(DEFAULT_BAND_OPTIONS) as BandId[]).map((id) => {
        const option = stored[id];
        return [
          id,
          {
            sort:
              typeof option?.sort === "string" && validSort(id, option.sort)
                ? option.sort
                : DEFAULT_BAND_OPTIONS[id].sort,
            grouped:
              typeof option?.grouped === "boolean"
                ? option.grouped
                : DEFAULT_BAND_OPTIONS[id].grouped,
          },
        ];
      }),
    ) as BandOptions;
  } catch {
    return DEFAULT_BAND_OPTIONS;
  }
}

export function useBandOptions() {
  const [options, setOptions] = useState(readBandOptions);
  useEffect(() => {
    try {
      window.localStorage.setItem(BAND_OPTIONS_KEY, JSON.stringify(options));
    } catch {
      // Section preferences are a convenience; losing them is harmless.
    }
  }, [options]);
  const update = useCallback(
    (section: BandId, change: Partial<BandOptions[BandId]>) =>
      setOptions((current) => ({
        ...current,
        [section]: { ...current[section], ...change },
      })),
    [],
  );
  return { bandOptions: options, updateBandOptions: update };
}
