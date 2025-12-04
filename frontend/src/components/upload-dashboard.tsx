"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  ChevronDown,
  X,
  Calendar,
  Map,
  List,
} from "lucide-react";
import { SightingsMap } from "@/components/sightings-map";
import { SightingsTable } from "@/components/sightings-table";
import { QueryBuilder } from "@/components/query-builder";
import { ActionsMenu } from "@/components/actions-menu";
import { FilterGroup } from "@/lib/filter-types";
import {
  apiFetch,
  buildApiUrl,
  buildFilterParams,
  checkApiResponse,
  getErrorMessage,
} from "@/lib/api";
import {
  UPLOAD_COUNT_ROUTE,
  UPLOAD_DETAILS_ROUTE,
  FIELD_VALUES_ROUTE,
} from "@/lib/generated/api_constants";
import {
  getEditToken as getStoredEditToken,
  setEditToken as setStoredEditToken,
} from "@/lib/storage";
import { getCountryName } from "@/lib/countries";

export interface UploadMetadata {
  upload_id: string;
  filename: string;
  row_count: number;
}

interface UploadDashboardProps {
  initialUpload: UploadMetadata;
}

type ViewMode = "map" | "table";

function getEditToken(uploadId: string): string | null {
  if (typeof window === "undefined") return null;

  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = urlParams.get("token");
  if (urlToken) return urlToken;

  return getStoredEditToken(uploadId);
}

export function UploadDashboard({ initialUpload }: UploadDashboardProps) {
  const searchParams = useSearchParams();
  const uploadId = initialUpload.upload_id;

  const [upload, setUpload] = useState<UploadMetadata>(initialUpload);
  const [filter, setFilter] = useState<FilterGroup | null>(null);
  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [filterOpen, setFilterOpen] = useState(false);
  const [lifersOnly, setLifersOnly] = useState(false);
  const [yearTickYear, setYearTickYear] = useState<number | null>(null);
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  const [countryTickCountry, setCountryTickCountry] = useState<string | null>(null);
  const [availableCountries, setAvailableCountries] = useState<string[]>([]);
  const [editToken] = useState<string | null>(() => getEditToken(uploadId));
  const [tableTopOffset, setTableTopOffset] = useState(200);
  const navigateToLocationRef = useRef<
    | ((sightingId: number, lat: number, lng: number) => void)
    | null
  >(null);
  const [mapReady, setMapReady] = useState(false);
  const topRightControlsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updateTableTop = () => {
      if (topRightControlsRef.current) {
        const rect = topRightControlsRef.current.getBoundingClientRect();
        setTableTopOffset(rect.bottom + 8);
      }
    };

    updateTableTop();
    window.addEventListener("resize", updateTableTop);
    return () => window.removeEventListener("resize", updateTableTop);
  }, [availableYears.length, availableCountries.length]);

  useEffect(() => {
    const urlToken = searchParams.get("token");
    if (urlToken && uploadId) {
      setStoredEditToken(uploadId, urlToken);

      const cleanUrl = `${window.location.origin}/single/${uploadId}`;
      window.history.replaceState({}, "", cleanUrl);
    }
  }, [searchParams, uploadId]);

  useEffect(() => {
    if (!uploadId) return;

    apiFetch(
      buildApiUrl(FIELD_VALUES_ROUTE, {
        upload_id: uploadId,
        field: "year",
      }),
    )
      .then((res) => {
        if (res.ok) {
          return res.json();
        }
        return { values: [] };
      })
      .then((data: { values: string[] }) => {
        const years = data.values
          .map((y) => parseInt(y, 10))
          .filter((y) => !isNaN(y))
          .sort((a, b) => b - a);
        setAvailableYears(years);
      })
      .catch(() => {});

    apiFetch(
      buildApiUrl(FIELD_VALUES_ROUTE, {
        upload_id: uploadId,
        field: "country_code",
      }),
    )
      .then((res) => {
        if (res.ok) {
          return res.json();
        }
        return { values: [] };
      })
      .then((data: { values: string[] }) => {
        const countries = data.values
          .filter((c) => c && c.trim() !== "")
          .sort((a, b) => {
            const nameA = getCountryName(a);
            const nameB = getCountryName(b);
            return nameA.localeCompare(nameB);
          });
        setAvailableCountries(countries);
      })
      .catch(() => {});
  }, [uploadId]);

  useEffect(() => {
    if (!uploadId) return;

    let cancelled = false;
    const params = buildFilterParams(filter, lifersOnly, yearTickYear, countryTickCountry);

    const url = `${buildApiUrl(UPLOAD_COUNT_ROUTE, { upload_id: uploadId })}?${params}`;

    apiFetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setFilteredCount(data.count);
      })
      .catch(() => {
        if (!cancelled) setFilteredCount(null);
      });

    return () => {
      cancelled = true;
      setFilteredCount(null);
    };
  }, [uploadId, filter, lifersOnly, yearTickYear, countryTickCountry]);

  const handleNavigateToSighting = useCallback(
    (sightingId: number, lat: number, lng: number) => {
      setViewMode("map");
      if (mapReady && navigateToLocationRef.current) {
        navigateToLocationRef.current(sightingId, lat, lng);
      }
    },
    [mapReady],
  );

  const handleUpdateComplete = useCallback(() => {
    apiFetch(buildApiUrl(UPLOAD_DETAILS_ROUTE, { upload_id: uploadId }))
      .then(async (res) => {
        await checkApiResponse(res, "Failed to refresh");
        return res.json();
      })
      .then((data: UploadMetadata) => {
        setUpload(data);
        setFilter(null);
        setFilteredCount(null);
      })
      .catch((err) => {
        console.error(getErrorMessage(err, "Failed to refresh"));
      });
  }, [uploadId]);

  const showingFiltered =
    (filter || lifersOnly || yearTickYear !== null || countryTickCountry !== null) &&
    filteredCount !== null &&
    filteredCount !== upload.row_count;

  return (
    <main className="fixed inset-0 overflow-hidden">
      <div className="absolute inset-0">
        <SightingsMap
          uploadId={upload.upload_id}
          filter={filter}
          lifersOnly={lifersOnly}
          yearTickYear={yearTickYear}
          countryTickCountry={countryTickCountry}
          onMapReady={(navigateFn) => {
            navigateToLocationRef.current = navigateFn;
            setMapReady(true);
          }}
        />
      </div>

      <div
        className={`absolute inset-x-0 bottom-0 bg-white shadow-2xl transition-transform duration-300 ease-out ${
          viewMode === "table" ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ top: `${tableTopOffset}px`, borderRadius: "16px 16px 0 0" }}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <span className="font-medium text-stone-900">
              {showingFiltered
                ? `${filteredCount?.toLocaleString()} of ${upload.row_count.toLocaleString()} sightings`
                : `${upload.row_count.toLocaleString()} sightings`}
            </span>
            <button
              onClick={() => setViewMode("map")}
              className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-stone-100 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="relative flex-1 overflow-hidden">
            <SightingsTable
              uploadId={upload.upload_id}
              filter={filter}
              lifersOnly={lifersOnly}
              yearTickYear={yearTickYear}
              countryTickCountry={countryTickCountry}
              onNavigateToSighting={handleNavigateToSighting}
            />
          </div>
        </div>
      </div>

      <div
        className={`absolute inset-0 md:bottom-4 md:left-4 md:top-4 md:w-[400px] md:rounded-2xl overflow-hidden bg-white shadow-2xl transition-transform duration-300 ease-out z-40 ${
          filterOpen
            ? "translate-x-0"
            : "-translate-x-full md:-translate-x-[calc(100%+32px)]"
        }`}
      >
        <QueryBuilder
          uploadId={upload.upload_id}
          onFilterChange={setFilter}
          onClose={() => setFilterOpen(false)}
          isPanel
        />
      </div>

      <div
        ref={topRightControlsRef}
        className={`absolute right-4 top-4 flex flex-col gap-2 z-50 transition-opacity ${
          filterOpen ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
      >
        <div className="flex gap-2">
          <button
            onClick={() => {
              const newLifersOnly = !lifersOnly;
              setLifersOnly(newLifersOnly);
              setYearTickYear(null);
              setCountryTickCountry(null);
            }}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors shadow-lg ${
              lifersOnly
                ? "bg-stone-900 text-white"
                : "bg-white text-stone-600 hover:bg-stone-50"
            }`}
            title={lifersOnly ? "Show all sightings" : "Show lifers only"}
          >
            <Sparkles className="h-4 w-4" />
            Lifers
          </button>
          {availableYears.length > 0 && (
            <div className="relative">
              <select
                value={yearTickYear || ""}
                onChange={(e) => {
                  const year = e.target.value
                    ? parseInt(e.target.value, 10)
                    : null;
                  setYearTickYear(year);
                  setLifersOnly(false);
                  setCountryTickCountry(null);
                }}
                className={`flex items-center gap-2 rounded-lg pl-9 pr-8 py-2 text-sm font-medium transition-colors shadow-lg cursor-pointer ${
                  yearTickYear
                    ? "bg-stone-900 text-white"
                    : "bg-white text-stone-600 hover:bg-stone-50"
                }`}
                style={{ appearance: "none" }}
              >
                {yearTickYear ? (
                  <option value="">Clear</option>
                ) : (
                  <option value="">Year tick</option>
                )}
                {availableYears.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
              <div className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                <Calendar
                  className={`h-4 w-4 ${
                    yearTickYear ? "text-white" : "text-stone-600"
                  }`}
                />
              </div>
              <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                <ChevronDown
                  className={`h-3 w-3 ${
                    yearTickYear ? "text-white" : "text-stone-400"
                  }`}
                />
              </div>
            </div>
          )}
          {availableCountries.length > 0 && (
            <div className="relative">
              <select
                value={countryTickCountry || ""}
                onChange={(e) => {
                  const country = e.target.value || null;
                  setCountryTickCountry(country);
                  setLifersOnly(false);
                  setYearTickYear(null);
                }}
                className={`flex items-center gap-2 rounded-lg pl-9 pr-8 py-2 text-sm font-medium transition-colors shadow-lg cursor-pointer ${
                  countryTickCountry
                    ? "bg-stone-900 text-white"
                    : "bg-white text-stone-600 hover:bg-stone-50"
                }`}
                style={{ appearance: "none" }}
              >
                {countryTickCountry ? (
                  <option value="">Clear</option>
                ) : (
                  <option value="">Country tick</option>
                )}
                {availableCountries.map((code) => (
                  <option key={code} value={code}>
                    {getCountryName(code)}
                  </option>
                ))}
              </select>
              <div className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                <Map
                  className={`h-4 w-4 ${
                    countryTickCountry ? "text-white" : "text-stone-600"
                  }`}
                />
              </div>
              <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                <ChevronDown
                  className={`h-3 w-3 ${
                    countryTickCountry ? "text-white" : "text-stone-400"
                  }`}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex overflow-hidden rounded-lg bg-white shadow-lg">
          <button
            onClick={() => setViewMode("map")}
            className={`flex flex-1 items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              viewMode === "map"
                ? "bg-stone-900 text-white"
                : "text-stone-600 hover:bg-stone-50"
            }`}
          >
            <Map className="h-4 w-4" />
            Map
          </button>
          <button
            onClick={() => setViewMode("table")}
            className={`flex flex-1 items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              viewMode === "table"
                ? "bg-stone-900 text-white"
                : "text-stone-600 hover:bg-stone-50"
            }`}
          >
            <List className="h-4 w-4" />
            List
          </button>
        </div>

        <ActionsMenu
          uploadId={upload.upload_id}
          filename={upload.filename}
          rowCount={upload.row_count}
          isFilterOpen={filterOpen}
          onToggleFilter={() => setFilterOpen((prev) => !prev)}
          filter={filter}
          editToken={editToken}
          onUpdateComplete={handleUpdateComplete}
        />
      </div>
    </main>
  );
}
