"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { apiFetch, buildApiUrl } from "@/lib/api";
import { FilterGroup, filterToJson } from "@/lib/filter-types";
import { formatCountry } from "@/lib/countries";
import {
  UPLOAD_SIGHTINGS_ROUTE,
  DEFAULT_PAGE_SIZE,
} from "@/lib/generated/api_constants";
import { SortField } from "@/lib/generated/SortField";
import { SightingsResponse } from "@/lib/generated/SightingsResponse";
import { GroupedSighting } from "@/lib/generated/GroupedSighting";
import { Sighting } from "@/lib/generated/Sighting";
import {
  MultiCombobox,
  MultiComboboxOption,
} from "@/components/ui/multi-combobox";

interface SightingsTableProps {
  uploadId: string;
  filter: FilterGroup | null;
  lifersOnly: boolean;
  yearTickYear: number | null;
  onNavigateToLocation?: (
    lat: number,
    lng: number,
    sightingData?: {
      name: string;
      scientificName?: string | null;
      count: number;
    }
  ) => void;
}

type SortDir = "asc" | "desc";

// Local type with number instead of bigint for display
type GroupedSightingDisplay = Omit<
  GroupedSighting,
  "count" | "species_count"
> & {
  count: number;
  species_count: number;
};

const COLUMNS: { field: SortField; label: string; width: string }[] = [
  { field: "common_name", label: "Species", width: "w-[200px]" },
  { field: "scientific_name", label: "Scientific Name", width: "w-[200px]" },
  { field: "count", label: "Count", width: "w-[80px]" },
  { field: "country_code", label: "Country", width: "w-[140px]" },
  { field: "observed_at", label: "Date", width: "w-[120px]" },
];

const GROUP_BY_OPTIONS: MultiComboboxOption[] = [
  { value: "country_code", label: "Country" },
  { value: "scientific_name", label: "Scientific Name" },
  { value: "common_name", label: "Species" },
  { value: "observed_at", label: "Date" },
];

export function SightingsTable({
  uploadId,
  filter,
  lifersOnly,
  yearTickYear,
  onNavigateToLocation,
}: SightingsTableProps) {
  const [sightings, setSightings] = useState<Sighting[]>([]);
  const [groups, setGroups] = useState<GroupedSightingDisplay[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [sortField, setSortField] = useState<SortField>("observed_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [groupBy, setGroupBy] = useState<string[]>([]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const pageRef = useRef(1);

  const fetchPage = useCallback(
    async (pageNum: number, append: boolean) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);

      const params = new URLSearchParams();
      params.set("sort_field", sortField);
      params.set("sort_dir", sortDir);
      params.set("page", String(pageNum));
      params.set("page_size", String(DEFAULT_PAGE_SIZE));

      if (filter) {
        params.set("filter", filterToJson(filter));
      }

      if (groupBy.length > 0) {
        params.set("group_by", groupBy.join(","));
      }

      if (lifersOnly) {
        params.set("lifers_only", "true");
      }

      if (yearTickYear !== null) {
        params.set("year_tick_year", String(yearTickYear));
      }

      try {
        const url = `${buildApiUrl(UPLOAD_SIGHTINGS_ROUTE, {
          upload_id: uploadId,
        })}?${params}`;

        const res = await apiFetch(url);
        if (!res.ok) {
          const errorText = await res.text();
          console.error("API error:", res.status, errorText);
          throw new Error(`API error: ${res.status}`);
        }
        const json: SightingsResponse = await res.json();

        if (groupBy.length > 0 && json.groups) {
          // Handle grouped response - convert bigint to number
          const groupsData: GroupedSightingDisplay[] = json.groups.map((g) => ({
            ...g,
            count: Number(g.count),
            species_count: Number(g.species_count),
          }));
          if (append) {
            setGroups((prev) => [...prev, ...groupsData]);
          } else {
            setGroups(groupsData);
          }
          setSightings([]);
        } else if (json.sightings) {
          // Handle individual sightings response
          if (append) {
            setSightings((prev) => [...prev, ...json.sightings!]);
          } else {
            setSightings(json.sightings);
          }
          setGroups([]);
        }

        setTotal(Number(json.total));
        setHasMore(pageNum < json.total_pages);
        pageRef.current = pageNum;
      } catch (e) {
        console.error("Failed to fetch sightings:", e);
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [uploadId, filter, sortField, sortDir, groupBy, lifersOnly, yearTickYear],
  );

  useEffect(() => {
    setSightings([]);
    setGroups([]);
    pageRef.current = 1;
    setHasMore(true);
    fetchPage(1, false);
  }, [fetchPage]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (loadingRef.current || !hasMore) return;

      const { scrollTop, scrollHeight, clientHeight } = container;
      const scrolledToBottom = scrollTop + clientHeight >= scrollHeight - 200;

      if (scrolledToBottom) {
        const nextPage = pageRef.current + 1;
        fetchPage(nextPage, true);
      }
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, [hasMore, fetchPage]);

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (field !== sortField) {
      return (
        <svg
          className="ml-1 h-3 w-3 opacity-30"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
          />
        </svg>
      );
    }

    return sortDir === "asc" ? (
      <svg
        className="ml-1 h-3 w-3"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M5 15l7-7 7 7"
        />
      </svg>
    ) : (
      <svg
        className="ml-1 h-3 w-3"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 9l-7 7-7-7"
        />
      </svg>
    );
  };

  const isGrouped = groupBy.length > 0;
  const displayItems = isGrouped ? groups : sightings;
  const displayCount = isGrouped ? groups.length : sightings.length;

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="shrink-0 border-b px-4 py-2 flex items-center justify-between text-sm">
        <div className="text-muted-foreground">
          {isGrouped ? (
            <>
              {total.toLocaleString()} group{total !== 1 ? "s" : ""}
              {displayCount < total &&
                ` (${displayCount.toLocaleString()} loaded)`}
            </>
          ) : (
            <>
              {total.toLocaleString()} sightings
              {displayCount < total &&
                ` (${displayCount.toLocaleString()} loaded)`}
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs">Group by:</span>
          <div className="w-[200px]">
            <MultiCombobox
              options={GROUP_BY_OPTIONS}
              values={groupBy}
              onChange={setGroupBy}
              placeholder="None"
              searchPlaceholder="Search fields..."
              emptyText="No fields found."
            />
          </div>
        </div>
      </div>

      <div className="shrink-0 border-b bg-background">
        <div className="flex text-sm font-medium">
          {isGrouped ? (
            <>
              {groupBy.includes("country_code") && (
                <div className="w-[140px] shrink-0 px-3 py-2">Country</div>
              )}
              {groupBy.includes("scientific_name") && (
                <div className="w-[200px] shrink-0 px-3 py-2">
                  Scientific Name
                </div>
              )}
              {groupBy.includes("common_name") && (
                <div className="w-[200px] shrink-0 px-3 py-2">Species</div>
              )}
              {groupBy.includes("observed_at") && (
                <div className="w-[120px] shrink-0 px-3 py-2">Date</div>
              )}
              <div className="w-[100px] shrink-0 px-3 py-2">
                <button
                  className="flex items-center hover:text-foreground transition-colors"
                  onClick={() => handleSort("count" as SortField)}
                >
                  Count
                  <SortIcon field={"count" as SortField} />
                </button>
              </div>
              <div className="w-[100px] shrink-0 px-3 py-2">
                <button
                  className="flex items-center hover:text-foreground transition-colors"
                  onClick={() => handleSort("species_count" as SortField)}
                >
                  Distinct species
                  <SortIcon field={"species_count" as SortField} />
                </button>
              </div>
              <div className="flex-1 px-3 py-2"></div>
            </>
          ) : (
            <>
              <div className="w-[60px] shrink-0 px-3 py-2"></div>
              {COLUMNS.map((col) => (
                <div
                  key={col.field}
                  className={`${col.width} shrink-0 px-3 py-2`}
                >
                  <button
                    className="flex items-center hover:text-foreground transition-colors"
                    onClick={() => handleSort(col.field)}
                  >
                    {col.label}
                    <SortIcon field={col.field} />
                  </button>
                </div>
              ))}
              <div className="flex-1 px-3 py-2"></div>
            </>
          )}
        </div>
      </div>

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0">
        {displayItems.length === 0 && !loading ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            {isGrouped ? "No groups found" : "No sightings found"}
          </div>
        ) : (
          <>
            {isGrouped
              ? groups.map((group, idx) => (
                  <div
                    key={idx}
                    className="flex border-b text-sm hover:bg-muted/50 transition-colors"
                  >
                    {groupBy.includes("country_code") && (
                      <div className="w-[140px] shrink-0 px-3 py-2">
                        {group.country_code
                          ? formatCountry(group.country_code)
                          : "—"}
                      </div>
                    )}
                    {groupBy.includes("scientific_name") && (
                      <div className="w-[200px] shrink-0 px-3 py-2 italic text-muted-foreground">
                        {group.scientific_name || "—"}
                      </div>
                    )}
                    {groupBy.includes("common_name") && (
                      <div className="w-[200px] shrink-0 px-3 py-2 font-medium">
                        {group.common_name || "—"}
                      </div>
                    )}
                    {groupBy.includes("observed_at") && (
                      <div className="w-[120px] shrink-0 px-3 py-2">
                        {group.observed_at
                          ? formatDate(group.observed_at)
                          : "—"}
                      </div>
                    )}
                    <div className="w-[100px] shrink-0 px-3 py-2 font-medium">
                      {group.count.toLocaleString()}
                    </div>
                    <div className="w-[100px] shrink-0 px-3 py-2 font-medium">
                      {group.species_count.toLocaleString()}
                    </div>
                    <div className="flex-1 px-3 py-2"></div>
                  </div>
                ))
              : sightings.map((sighting) => (
                  <div
                    key={Number(sighting.id)}
                    className="flex border-b text-sm hover:bg-muted/50 transition-colors"
                  >
                    <div className="w-[60px] shrink-0 px-3 py-2 flex items-center justify-center">
                      {sighting.latitude != null &&
                      sighting.longitude != null ? (
                        <button
                          onClick={() => {
                            const lat = Number(sighting.latitude);
                            const lng = Number(sighting.longitude);
                            if (
                              onNavigateToLocation &&
                              !isNaN(lat) &&
                              !isNaN(lng) &&
                              isFinite(lat) &&
                              isFinite(lng)
                            ) {
                              onNavigateToLocation(lat, lng, {
                                name: sighting.common_name,
                                scientificName: sighting.scientific_name,
                                count:
                                  sighting.count !== null
                                    ? Number(sighting.count)
                                    : 1,
                              });
                            }
                          }}
                          disabled={!onNavigateToLocation}
                          className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Show on map"
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                            <circle cx="12" cy="10" r="3" />
                          </svg>
                        </button>
                      ) : null}
                    </div>
                    <div className="w-[200px] shrink-0 px-3 py-2 font-medium">
                      {sighting.common_name}
                    </div>
                    <div className="w-[200px] shrink-0 px-3 py-2 italic text-muted-foreground">
                      {sighting.scientific_name || "—"}
                    </div>
                    <div className="w-[80px] shrink-0 px-3 py-2">
                      {sighting.count !== null
                        ? Number(sighting.count).toLocaleString()
                        : "—"}
                    </div>
                    <div className="w-[140px] shrink-0 px-3 py-2">
                      {sighting.country_code
                        ? formatCountry(sighting.country_code)
                        : "—"}
                    </div>
                    <div className="w-[120px] shrink-0 px-3 py-2">
                      {formatDate(sighting.observed_at)}
                    </div>
                    <div className="flex-1 px-3 py-2"></div>
                  </div>
                ))}

            {loading && (
              <div className="flex justify-center py-4">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              </div>
            )}

            {!hasMore && displayItems.length > 0 && (
              <div className="py-4 text-center text-sm text-muted-foreground">
                All {total.toLocaleString()}{" "}
                {isGrouped ? "groups" : "sightings"} loaded
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
