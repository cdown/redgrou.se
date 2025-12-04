"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { MapPin } from "lucide-react";
import {
  apiFetch,
  buildApiUrl,
  buildFilterParams,
  checkApiResponse,
  getErrorMessage,
  parseProtoResponse,
} from "@/lib/api";
import { FilterGroup, filterToJson } from "@/lib/filter-types";
import { formatCountry } from "@/lib/countries";
import { formatRegion } from "@/lib/regions";
import {
  UPLOAD_SIGHTINGS_ROUTE,
  DEFAULT_PAGE_SIZE,
} from "@/lib/generated/api_constants";
import { SortField } from "@/lib/sort-field";
import type {
  Sighting as SightingMessage,
  GroupedSighting as GroupedSightingMessage,
  Species,
} from "@/lib/proto/redgrouse_api";
import { SightingsResponse as SightingsResponseDecoder } from "@/lib/proto/redgrouse_api";
import {
  MultiCombobox,
  MultiComboboxOption,
} from "@/components/ui/multi-combobox";
import { formatDisplayDate } from "@/lib/utils";

interface SightingsTableProps {
  uploadId: string;
  filter: FilterGroup | null;
  lifersOnly: boolean;
  yearTickYear: number | null;
  countryTickCountry: string | null;
  onNavigateToSighting?: (sightingId: number, lat: number, lng: number) => void;
}

type SortDir = "asc" | "desc";

type GroupedSightingDisplay = Omit<
  GroupedSightingMessage,
  "count" | "speciesCount"
> & {
  count: number;
  speciesCount: number;
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

function getNameFromIndex(
  nameIndex: Species[],
  index: number | undefined,
): { commonName: string; scientificName?: string } | null {
  if (index === undefined || index < 0 || index >= nameIndex.length) {
    return null;
  }
  const species = nameIndex[index];
  return {
    commonName: species.commonName,
    scientificName: species.scientificName,
  };
}

export function SightingsTable({
  uploadId,
  filter,
  lifersOnly,
  yearTickYear,
  countryTickCountry,
  onNavigateToSighting,
}: SightingsTableProps) {
  const [sightings, setSightings] = useState<SightingMessage[]>([]);
  const [groups, setGroups] = useState<GroupedSightingDisplay[]>([]);
  const [nameIndex, setNameIndex] = useState<Species[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [sortField, setSortField] = useState<SortField>("observed_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [groupBy, setGroupBy] = useState<string[]>([]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const pageRef = useRef(1);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(
    async (pageNum: number, append: boolean) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);

      const params = buildFilterParams(
        filter ? filterToJson(filter) : null,
        lifersOnly,
        yearTickYear,
        countryTickCountry
      );
      params.set("sort_field", sortField);
      params.set("sort_dir", sortDir);
      params.set("page", String(pageNum));
      params.set("page_size", String(DEFAULT_PAGE_SIZE));

      if (groupBy.length > 0) {
        params.set("group_by", groupBy.join(","));
      }

      try {
        const url = `${buildApiUrl(UPLOAD_SIGHTINGS_ROUTE, {
          upload_id: uploadId,
        })}?${params}`;

        const res = await apiFetch(url);
        await checkApiResponse(res, "Failed to fetch sightings");
        const data = await parseProtoResponse(res, SightingsResponseDecoder);

        setNameIndex(data.nameIndex);

        if (groupBy.length > 0) {
          const groupsData: GroupedSightingDisplay[] = data.groups.map((g) => ({
            ...g,
            count: Number(g.count),
            speciesCount: Number(g.speciesCount),
          }));
          if (append) {
            setGroups((prev) => [...prev, ...groupsData]);
          } else {
            setGroups(groupsData);
          }
          setSightings([]);
        } else {
          if (append) {
            setSightings((prev) => [...prev, ...data.sightings]);
          } else {
            setSightings(data.sightings);
          }
          setGroups([]);
        }

        setTotal(Number(data.total));
        setHasMore(pageNum < data.totalPages);
        pageRef.current = pageNum;
      } catch (e) {
        console.error("Failed to fetch sightings:", getErrorMessage(e, "Unknown error"));
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [uploadId, filter, sortField, sortDir, groupBy, lifersOnly, yearTickYear, countryTickCountry],
  );

  useEffect(() => {
    setSightings([]);
    setGroups([]);
    setNameIndex([]);
    pageRef.current = 1;
    setHasMore(true);
    fetchPage(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadId, filter, sortField, sortDir, groupBy, lifersOnly, yearTickYear, countryTickCountry]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry.isIntersecting && !loadingRef.current && hasMore) {
          const nextPage = pageRef.current + 1;
          fetchPage(nextPage, true);
        }
      },
      {
        root: container,
        rootMargin: "200px",
        threshold: 0,
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, fetchPage]);

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
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

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="shrink-0 border-b px-4 py-2 flex items-center justify-between text-sm">
        <div className="text-muted-foreground">
          {isGrouped ? (
            <>
              {total.toLocaleString()} group{total !== 1 ? "s" : ""}
            </>
          ) : (
            <>{total.toLocaleString()} sightings</>
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
              {COLUMNS.slice(0, 4).map((col) => (
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
              <div className="w-[140px] shrink-0 px-3 py-2">Region</div>
              {COLUMNS.slice(4).map((col) => (
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
                        {group.countryCode
                          ? formatCountry(group.countryCode)
                          : "—"}
                      </div>
                    )}
                    {groupBy.includes("scientific_name") && (() => {
                      const names = getNameFromIndex(nameIndex, group.commonNameIndex);
                      return (
                        <div className="w-[200px] shrink-0 px-3 py-2 italic text-muted-foreground">
                          {names?.scientificName || "—"}
                        </div>
                      );
                    })()}
                    {groupBy.includes("common_name") && (() => {
                      const names = getNameFromIndex(nameIndex, group.commonNameIndex);
                      return (
                        <div className="w-[200px] shrink-0 px-3 py-2 font-medium">
                          {names?.commonName || "—"}
                        </div>
                      );
                    })()}
                    {groupBy.includes("observed_at") && (
                      <div className="w-[120px] shrink-0 px-3 py-2">
                        {group.observedAt
                          ? formatDisplayDate(group.observedAt)
                          : "—"}
                      </div>
                    )}
                    <div className="w-[100px] shrink-0 px-3 py-2 font-medium">
                      {group.count.toLocaleString()}
                    </div>
                    <div className="w-[100px] shrink-0 px-3 py-2 font-medium">
                      {group.speciesCount.toLocaleString()}
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
                            const sightingId = Number(sighting.id);
                            const lat = Number(sighting.latitude);
                            const lng = Number(sighting.longitude);
                            if (
                              onNavigateToSighting &&
                              !isNaN(sightingId) &&
                              isFinite(sightingId) &&
                              !isNaN(lat) &&
                              !isNaN(lng) &&
                              isFinite(lat) &&
                              isFinite(lng)
                            ) {
                              onNavigateToSighting(sightingId, lat, lng);
                            }
                          }}
                          disabled={!onNavigateToSighting}
                          className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Show on map"
                        >
                          <MapPin className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>
                    {(() => {
                      const names = getNameFromIndex(nameIndex, sighting.commonNameIndex);
                      return (
                        <>
                          <div className="w-[200px] shrink-0 px-3 py-2 font-medium">
                            {names?.commonName || "—"}
                          </div>
                          <div className="w-[200px] shrink-0 px-3 py-2 italic text-muted-foreground">
                            {names?.scientificName || "—"}
                          </div>
                        </>
                      );
                    })()}
                    <div className="w-[80px] shrink-0 px-3 py-2">
                      {sighting.count !== null
                        ? Number(sighting.count).toLocaleString()
                        : "—"}
                    </div>
                    <div className="w-[140px] shrink-0 px-3 py-2">
                      {sighting.countryCode
                        ? formatCountry(sighting.countryCode)
                        : "—"}
                    </div>
                    <div className="w-[140px] shrink-0 px-3 py-2">
                      {formatRegion(sighting.regionCode)}
                    </div>
                    <div className="w-[120px] shrink-0 px-3 py-2">
                      {formatDisplayDate(sighting.observedAt)}
                    </div>
                    <div className="flex-1 px-3 py-2"></div>
                  </div>
                ))}

            <div ref={sentinelRef} className="h-1" />

            {loading && (
              <div className="flex justify-center py-4">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              </div>
            )}

            {!hasMore && displayItems.length > 0 && (
              <div className="py-4 text-center text-sm text-muted-foreground">
                All {total.toLocaleString()}{" "}
                {isGrouped ? "groups" : "sightings"}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
