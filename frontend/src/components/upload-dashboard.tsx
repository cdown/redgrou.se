"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryState } from "nuqs";
import { searchParamsCache } from "@/lib/search-params";
import { FilterGroup } from "@/lib/filter-types";
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
import { ColorLegend } from "@/components/color-legend";
import {
  apiFetch,
  buildApiUrl,
  buildFilterParams,
  checkApiResponse,
  parseProtoResponse,
  getErrorMessage,
} from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import {
  UPLOAD_COUNT_ROUTE,
  UPLOAD_DETAILS_ROUTE,
  FIELD_VALUES_ROUTE,
  UPLOAD_SIGHTINGS_ROUTE,
} from "@/lib/generated/api_constants";
import {
  getEditToken as getStoredEditToken,
  setEditToken as setStoredEditToken,
} from "@/lib/storage";
import { getCountryName } from "@/lib/countries";
import type { UploadMetadata as UploadMetadataMessage } from "@/lib/proto/redgrouse_api";
import type { Species } from "@/lib/proto/redgrouse_api";
import {
  CountResponse,
  FieldValues as FieldValuesDecoder,
  UploadMetadata as UploadMetadataDecoder,
  SightingsResponse as SightingsResponseDecoder,
} from "@/lib/proto/redgrouse_api";
import {
  deriveTitleFromFilename,
  UPLOAD_EVENTS_CHANNEL,
  type UploadBroadcastEvent,
} from "@/lib/uploads";

export type UploadMetadata = UploadMetadataMessage;

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

async function fetchNameIndex(uploadId: string): Promise<Species[]> {
  const params = new URLSearchParams();
  params.set("page_size", "1");

  const url = `${buildApiUrl(UPLOAD_SIGHTINGS_ROUTE, {
    upload_id: uploadId,
  })}?${params}`;

  const res = await apiFetch(url);
  await checkApiResponse(res, "Failed to load name index");
  const data = await parseProtoResponse(res, SightingsResponseDecoder);
  return data.nameIndex;
}

export function UploadDashboard({ initialUpload }: UploadDashboardProps) {
  const { showToast } = useToast();
  const searchParams = useSearchParams();
  const uploadId = initialUpload.uploadId;
  const router = useRouter();

  const [upload, setUpload] = useState<UploadMetadata>(initialUpload);
  const [pendingDataVersion, setPendingDataVersion] = useState<number | null>(null);
  const [isDeleted, setIsDeleted] = useState(false);
  const [filterString, setFilterString] = useQueryState(
    "filter",
    searchParamsCache.filter.withOptions({ history: "push" })
  );
  const currentDataVersion = upload.dataVersion ?? 1;

  const observeVersion = useCallback(
    (version?: number | null) => {
      if (typeof version !== "number") {
        return;
      }
      if (version > currentDataVersion) {
        setPendingDataVersion((prev) => {
          if (prev && prev >= version) {
            return prev;
          }
          return version;
        });
      }
    },
    [currentDataVersion],
  );

  const filter: FilterGroup | null = useMemo(
    () =>
      filterString
        ? (() => {
            try {
              return JSON.parse(filterString) as FilterGroup;
            } catch (err) {
              console.error("Failed to parse filter string:", err, filterString);
              return null;
            }
          })()
        : null,
    [filterString]
  );

  const setFilter = useCallback(
    (value: FilterGroup | null) => {
      setFilterString(value ? JSON.stringify(value) : null);
    },
    [setFilterString]
  );
  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [filterOpen, setFilterOpen] = useState(false);
  const [lifersOnly, setLifersOnly] = useQueryState(
    "lifers_only",
    searchParamsCache.lifers_only
  );
  const [yearTickYear, setYearTickYear] = useQueryState(
    "year_tick_year",
    searchParamsCache.year_tick_year
  );
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  const [countryTickCountry, setCountryTickCountry] = useQueryState(
    "country_tick_country",
    searchParamsCache.country_tick_country
  );
  const [availableCountries, setAvailableCountries] = useState<string[]>([]);
  const [nameIndex, setNameIndex] = useState<Species[]>([]);
  const resolvedTitle = useMemo(() => {
    if (upload.title && upload.title.trim().length > 0) {
      return upload.title;
    }
    return deriveTitleFromFilename(upload.filename);
  }, [upload.title, upload.filename]);

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
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(UPLOAD_EVENTS_CHANNEL);
    channel.onmessage = (event: MessageEvent<UploadBroadcastEvent>) => {
      const payload = event.data;
      if (!payload || payload.uploadId !== uploadId) {
        return;
      }
      if (payload.type === "updated") {
        observeVersion(payload.dataVersion ?? null);
      } else if (payload.type === "deleted") {
        setIsDeleted(true);
      }
    };

    return () => {
      channel.close();
    };
  }, [uploadId, observeVersion]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    const poll = () => {
      if (cancelled || document.hidden || isDeleted) {
        return;
      }

      apiFetch(buildApiUrl(UPLOAD_DETAILS_ROUTE, { upload_id: uploadId }))
        .then(async (res) => {
          if (res.status === 404) {
            setIsDeleted(true);
            return null;
          }
          await checkApiResponse(res, "Upload not found");
          return parseProtoResponse(res, UploadMetadataDecoder);
        })
        .then((data) => {
          if (!data) return;
          observeVersion(data.dataVersion);
        })
        .catch((err) => {
          const message = getErrorMessage(err, "Failed to check upload status");
          if (message === "Upload not found") {
            setIsDeleted(true);
          }
        });
    };

    const interval = window.setInterval(poll, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [uploadId, observeVersion, isDeleted]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.title = `${resolvedTitle} | redgrou.se`;
    }
  }, [resolvedTitle]);

  useEffect(() => {
    if (!uploadId || isDeleted) return;

    apiFetch(
      buildApiUrl(FIELD_VALUES_ROUTE, {
        upload_id: uploadId,
        field: "year",
      }),
    )
      .then(async (res) => {
        await checkApiResponse(res, "Failed to load available years");
        return parseProtoResponse(res, FieldValuesDecoder);
      })
      .then((data) => {
        observeVersion(data.dataVersion);
        const years = data.values
          .map((y) => parseInt(y, 10))
          .filter((y) => !isNaN(y))
          .sort((a, b) => b - a);
        setAvailableYears(years);
      })
      .catch((err) => {
        console.error("Failed to fetch year field values:", err);
        showToast(getErrorMessage(err, "Failed to load available years"), "error");
      });

    apiFetch(
      buildApiUrl(FIELD_VALUES_ROUTE, {
        upload_id: uploadId,
        field: "country_code",
      }),
    )
      .then(async (res) => {
        await checkApiResponse(res, "Failed to load available countries");
        return parseProtoResponse(res, FieldValuesDecoder);
      })
      .then((data) => {
        observeVersion(data.dataVersion);
        const countries = data.values
          .filter((c) => c && c.trim() !== "")
          .sort((a, b) => {
            const nameA = getCountryName(a);
            const nameB = getCountryName(b);
            return nameA.localeCompare(nameB);
          });
        setAvailableCountries(countries);
      })
      .catch((err) => {
        console.error("Failed to fetch country field values:", err);
        showToast(getErrorMessage(err, "Failed to load available countries"), "error");
      });
  }, [uploadId, showToast, observeVersion, isDeleted]);

  useEffect(() => {
    if (!uploadId || isDeleted) return;

    fetchNameIndex(uploadId)
      .then((index) => {
        setNameIndex(index);
      })
      .catch((err) => {
        console.error("Failed to fetch name index:", err);
        showToast(getErrorMessage(err, "Failed to load species names"), "error");
      });
  }, [uploadId, showToast, isDeleted]);

  useEffect(() => {
    if (!uploadId || isDeleted) return;

    let cancelled = false;
    const params = buildFilterParams(filterString, lifersOnly, yearTickYear, countryTickCountry);

    const url = `${buildApiUrl(UPLOAD_COUNT_ROUTE, { upload_id: uploadId })}?${params}`;

    apiFetch(url)
      .then(async (res) => {
        if (res.status === 404) {
          setIsDeleted(true);
          return null;
        }
        await checkApiResponse(res, "Failed to load filtered count");
        return parseProtoResponse(res, CountResponse);
      })
      .then((data) => {
        if (!data || cancelled) return;
        observeVersion(data.dataVersion);
        setFilteredCount(Number(data.count));
      })
      .catch((err) => {
        console.error("Failed to fetch filtered count:", err);
        if (cancelled) {
          return;
        }
        const message = getErrorMessage(err, "Failed to load filtered count");
        if (message === "Upload not found") {
          setIsDeleted(true);
          return;
        }
        setFilteredCount(null);
        showToast(message, "error");
      });

    return () => {
      cancelled = true;
      setFilteredCount(null);
    };
  }, [
    uploadId,
    filterString,
    lifersOnly,
    yearTickYear,
    countryTickCountry,
    showToast,
    observeVersion,
    isDeleted,
  ]);

  const handleNavigateToSighting = useCallback(
    (sightingId: number, lat: number, lng: number) => {
      setViewMode("map");
      if (mapReady && navigateToLocationRef.current) {
        navigateToLocationRef.current(sightingId, lat, lng);
      }
    },
    [mapReady],
  );

  const refreshUpload = useCallback(() => {
    apiFetch(buildApiUrl(UPLOAD_DETAILS_ROUTE, { upload_id: uploadId }))
      .then(async (res) => {
        if (res.status === 404) {
          setIsDeleted(true);
          return null;
        }
        await checkApiResponse(res, "Failed to refresh");
        return parseProtoResponse(res, UploadMetadataDecoder);
      })
      .then((data) => {
        if (!data) return;
        setUpload(data);
        setFilter(null);
        setFilteredCount(null);
        setPendingDataVersion(null);
        setIsDeleted(false);
      })
      .catch((err) => {
        console.error("Failed to refresh upload:", err);
        const message = getErrorMessage(err, "Failed to refresh upload");
        if (message === "Upload not found") {
          setIsDeleted(true);
          return;
        }
        showToast(message, "error");
      });

    fetchNameIndex(uploadId)
      .then((index) => {
        setNameIndex(index);
      })
      .catch((err) => {
        console.error("Failed to fetch name index after update:", err);
        const message = getErrorMessage(err, "Failed to reload species names");
        if (message === "Upload not found") {
          setIsDeleted(true);
          return;
        }
        showToast(message, "error");
      });
  }, [uploadId, setFilter, showToast]);

  const handleRenameComplete = useCallback(
    (metadata: UploadMetadata) => {
      setUpload(metadata);
      setPendingDataVersion(null);
      setIsDeleted(false);
    },
    [],
  );

  const showingFiltered =
    (filter || lifersOnly || yearTickYear !== null || countryTickCountry !== null) &&
    filteredCount !== null &&
    filteredCount !== upload.rowCount;

  const hasPendingUpdate =
    pendingDataVersion !== null && pendingDataVersion > currentDataVersion;

  if (isDeleted) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 bg-stone-50 px-4 text-center">
        <div className="text-2xl font-semibold text-stone-900">This upload is no longer available.</div>
        <p className="max-w-md text-sm text-stone-600">
          The owner has deleted or replaced this dataset. You can try refreshing once more or return
          to the uploads page.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={refreshUpload}
            className="rounded-full bg-stone-900 px-5 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
          >
            Retry
          </button>
          <button
            onClick={() => router.push("/")}
            className="rounded-full border border-stone-300 px-5 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 transition-colors"
          >
            Back to uploads
          </button>
        </div>
      </main>
    );
  }

  return (
    <>
      {hasPendingUpdate && (
        <div className="pointer-events-none fixed left-1/2 top-4 z-50 -translate-x-1/2 px-4">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-stone-900/90 px-4 py-2 text-sm text-white shadow-2xl">
            <span>Dataset updated elsewhere.</span>
            <button
              onClick={refreshUpload}
              className="rounded-full bg-white/20 px-3 py-1 text-xs font-semibold text-white hover:bg-white/30 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      )}
      <main className="fixed inset-0 overflow-hidden">
      <div className="absolute inset-0">
        <SightingsMap
          uploadId={upload.uploadId}
          filter={filter}
          lifersOnly={lifersOnly}
          yearTickYear={yearTickYear}
          countryTickCountry={countryTickCountry}
          dataVersion={currentDataVersion}
          onRemoteVersionObserved={observeVersion}
          onUploadDeleted={() => setIsDeleted(true)}
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
                ? `${filteredCount?.toLocaleString()} of ${upload.rowCount.toLocaleString()} sightings`
                : `${upload.rowCount.toLocaleString()} sightings`}
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
              uploadId={upload.uploadId}
              filter={filter}
              lifersOnly={lifersOnly}
              yearTickYear={yearTickYear}
              countryTickCountry={countryTickCountry}
              nameIndex={nameIndex}
              onNavigateToSighting={handleNavigateToSighting}
              onRemoteVersionObserved={observeVersion}
              onUploadDeleted={() => setIsDeleted(true)}
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
          uploadId={upload.uploadId}
          onFilterChange={setFilter}
          onClose={() => setFilterOpen(false)}
          isPanel
        />
      </div>

      <ColorLegend filterOpen={filterOpen} />

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
          uploadId={upload.uploadId}
          filename={upload.filename}
          title={resolvedTitle}
          rowCount={upload.rowCount}
          isFilterOpen={filterOpen}
          onToggleFilter={() => setFilterOpen((prev) => !prev)}
          filter={filter}
          editToken={editToken}
          onUpdateComplete={refreshUpload}
          onRenameComplete={handleRenameComplete}
        />
      </div>
    </main>
    </>
  );
}
