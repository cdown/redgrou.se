"use client";

import { useState, useCallback, useRef, useEffect, useMemo, ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryState, parseAsInteger, parseAsString } from "nuqs";
import { FilterGroup } from "@/lib/filter-types";
import { Sparkles, ChevronDown, Check, X } from "lucide-react";
import { SightingsMap } from "@/components/sightings-map";
import { SightingsTable } from "@/components/sightings-table";
import { QueryBuilder } from "@/components/query-builder";
import { ActionsMenu } from "@/components/actions-menu";
import { ColorLegend } from "@/components/color-legend";
import { useToast } from "@/components/ui/toast";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  getEditToken as getStoredEditToken,
  setEditToken as setStoredEditToken,
} from "@/lib/storage";
import type { UploadMetadata as UploadMetadataMessage } from "@/lib/proto/redgrouse_api";
import { deriveTitleFromFilename } from "@/lib/uploads";
import {
  TickFilterSelection,
  ensureTickLocks,
  parseTickFilterParam,
  serializeTickFilterSelection,
} from "@/lib/tick-filters";
import {
  COLOUR_COUNTRY_TICK,
  COLOUR_LIFER,
  COLOUR_YEAR_TICK,
} from "@/lib/colours";
import { getErrorMessage } from "@/lib/api";
import {
  useUploadMetadata,
  useFilteredCount,
  useNameIndex,
  useYears,
  useCountries,
} from "@/lib/hooks/upload";
import { TickControls } from "@/components/upload/tick-controls";

export type UploadMetadata = UploadMetadataMessage;

interface UploadDashboardProps {
  initialUpload: UploadMetadata;
}

type ViewMode = "map" | "table";

type TickMode = "lifers" | "lifers_and_ticks" | "all";

const TICK_MODE_PRESETS: Record<TickMode, TickFilterSelection> = {
  lifers: { lifer: true, year: false, country: false, normal: false },
  lifers_and_ticks: { lifer: true, year: true, country: true, normal: false },
  all: { lifer: true, year: true, country: true, normal: true },
};

const TICK_MODE_DEFS: Array<{
  key: TickMode;
  label: string;
  description: string;
  swatches?: string[];
}> = [
  {
    key: "lifers",
    label: "Lifers only",
    description: "Only the first sighting of each species",
    swatches: [COLOUR_LIFER],
  },
  {
    key: "lifers_and_ticks",
    label: "Lifers + ticks",
    description: "Includes lifers, year ticks, and country ticks",
    swatches: [COLOUR_LIFER, COLOUR_YEAR_TICK, COLOUR_COUNTRY_TICK],
  },
  {
    key: "all",
    label: "All sightings",
    description: "Highlights plus every other observation",
  },
];

const TickFilterButtonBase = ({
  tickIndicator,
  tickMode,
  onSelectMode,
}: {
  tickIndicator: ReactNode;
  tickMode: TickMode;
  onSelectMode: (mode: TickMode) => void;
}) => (
  <Popover>
    <PopoverTrigger asChild>
      <button
        className="flex w-[180px] items-center gap-3 rounded-lg bg-white px-3 py-2 text-left text-sm font-medium text-stone-700 shadow-lg transition-colors hover:bg-stone-50"
      >
        <Sparkles className="h-4 w-4 text-stone-500" />
        <div className="flex-1 text-left">
          <span className="text-sm font-semibold text-stone-900">Sightings</span>
        </div>
        <div className="flex w-16 items-center justify-end gap-1">
          <div className="flex max-w-[48px] justify-end">{tickIndicator}</div>
          <ChevronDown className="h-3 w-3 text-stone-400 flex-shrink-0" />
        </div>
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="end"
      className="w-64 rounded-xl border border-stone-200 bg-white p-3 shadow-xl"
    >
      <p className="px-1 pb-2 text-xs text-stone-500">
        Choose which sightings appear on the map and in the table.
      </p>
      <div className="flex flex-col gap-1">
        {TICK_MODE_DEFS.map((option) => {
          const isSelected = tickMode === option.key;
          return (
            <button
              key={option.key}
              onClick={() => onSelectMode(option.key)}
              className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors ${
                isSelected ? "bg-stone-100" : "hover:bg-stone-100"
              }`}
            >
              <div className="flex items-center gap-1">
                {option.swatches ? (
                  option.swatches.map((color) => (
                    <span
                      key={color}
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                  ))
                ) : (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                    All
                  </span>
                )}
              </div>
              <div className="flex flex-1 flex-col text-left">
                <span className="font-medium text-stone-900">{option.label}</span>
                <span className="text-xs text-stone-500">{option.description}</span>
              </div>
              {isSelected && <Check className="h-4 w-4 text-stone-900" />}
            </button>
          );
        })}
      </div>
    </PopoverContent>
  </Popover>
);

const TickFilterButtonFallback = () => (
  <button
    className="flex w-[180px] items-center gap-3 rounded-lg bg-white px-3 py-2 text-left text-sm font-medium text-stone-400 shadow-lg"
    disabled
  >
    <Sparkles className="h-4 w-4 opacity-50" />
    <div className="flex-1 text-left">
      <span className="text-sm font-semibold">Sightings</span>
    </div>
    <div className="flex w-16 items-center justify-end gap-1">
      <div className="h-2.5 w-12 rounded-full bg-stone-200" />
      <ChevronDown className="h-3 w-3 opacity-50" />
    </div>
  </button>
);

const ClientTickFilterButton = dynamic(
  () => Promise.resolve({ default: TickFilterButtonBase }),
  {
    ssr: false,
    loading: () => <TickFilterButtonFallback />,
  },
);

function modeFromSelection(selection: TickFilterSelection): TickMode {
  if (selection.normal) {
    return "all";
  }
  if (selection.year || selection.country) {
    return "lifers_and_ticks";
  }
  return "lifers";
}

function selectionFromMode(mode: TickMode): TickFilterSelection {
  const preset = TICK_MODE_PRESETS[mode];
  return {
    normal: preset.normal,
    lifer: preset.lifer,
    year: preset.year,
    country: preset.country,
  };
}

function getEditToken(uploadId: string): string | null {
  if (typeof window === "undefined") return null;

  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = urlParams.get("token");
  if (urlToken) return urlToken;

  return getStoredEditToken(uploadId);
}

export function UploadDashboard({ initialUpload }: UploadDashboardProps) {
  const { showToast } = useToast();
  const searchParams = useSearchParams();
  const router = useRouter();

  const {
    upload,
    isDeleted,
    currentDataVersion,
    observeVersion,
    refreshUpload: refreshUploadMetadata,
    applyRemoteMetadata,
    markDeleted,
  } = useUploadMetadata(initialUpload);
  const uploadId = upload.uploadId;

  const [filterParam, setFilterParam] = useQueryState("filter", parseAsString);
  const [tickFilterParam, setTickFilterParam] = useQueryState("tick_filter", parseAsString);
  const [yearTickYear, setYearTickYear] = useQueryState("year_tick_year", parseAsInteger);
  const [countryTickCountry, setCountryTickCountry] = useQueryState(
    "country_tick_country",
    parseAsString,
  );

  const filter: FilterGroup | null = useMemo(
    () =>
      filterParam
        ? (() => {
            try {
              return JSON.parse(filterParam) as FilterGroup;
            } catch (err) {
              console.error("Failed to parse filter string:", err, filterParam);
              return null;
            }
          })()
        : null,
    [filterParam],
  );

  const setFilter = useCallback(
    (value: FilterGroup | null) => {
      void setFilterParam(value ? JSON.stringify(value) : null);
    },
    [setFilterParam],
  );
  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [filterOpen, setFilterOpen] = useState(false);
  const handleFieldValuesError = useCallback(
    (message: string, err?: unknown) => {
      if (err) {
        console.error(message, err);
      }
      showToast(message, "error");
    },
    [showToast],
  );
  const tickLocks = useMemo(
    () => ({
      year: yearTickYear !== null,
      country: countryTickCountry !== null,
    }),
    [yearTickYear, countryTickCountry],
  );
  const baseTickSelection = useMemo(
    () => parseTickFilterParam(tickFilterParam),
    [tickFilterParam],
  );
  const tickSelection = useMemo(
    () => ensureTickLocks(baseTickSelection, tickLocks),
    [baseTickSelection, tickLocks],
  );
  const effectiveTickFilterParam = useMemo(
    () => serializeTickFilterSelection(tickSelection),
    [tickSelection],
  );
  const tickMode = useMemo(
    () => modeFromSelection(tickSelection),
    [tickSelection],
  );
  const tickIndicator = useMemo(() => {
    switch (tickMode) {
      case "all":
        return (
          <span className="w-full text-right text-[10px] font-semibold uppercase tracking-wide text-stone-500">
            All
          </span>
        );
      case "lifers_and_ticks":
        return (
          <div className="flex w-full justify-end gap-1">
            {[COLOUR_LIFER, COLOUR_YEAR_TICK, COLOUR_COUNTRY_TICK].map((color) => (
              <span
                key={color}
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        );
      case "lifers":
      default:
        return (
          <div className="flex w-full justify-end">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: COLOUR_LIFER }}
            />
          </div>
        );
    }
  }, [tickMode]);
  const handleTickModeChange = useCallback(
    (mode: TickMode) => {
      const nextSelection = ensureTickLocks(selectionFromMode(mode), tickLocks);
      void setTickFilterParam(serializeTickFilterSelection(nextSelection));
    },
    [tickLocks, setTickFilterParam],
  );
  const handleYearChange = useCallback(
    (year: number | null) => {
      void setYearTickYear(year);
      void setCountryTickCountry(null);
    },
    [setYearTickYear, setCountryTickCountry],
  );
  const handleCountryChange = useCallback(
    (country: string | null) => {
      void setCountryTickCountry(country);
      void setYearTickYear(null);
    },
    [setCountryTickCountry, setYearTickYear],
  );
  const {
    years: availableYears,
    dataVersion: yearsVersion,
  } = useYears(!isDeleted ? uploadId : null, {
    enabled: !isDeleted,
    onError: handleFieldValuesError,
  });
  const {
    countries: availableCountries,
    dataVersion: countriesVersion,
  } = useCountries(!isDeleted ? uploadId : null, {
    enabled: !isDeleted,
    onError: handleFieldValuesError,
  });
  const {
    nameIndex,
    refresh: refreshNameIndex,
  } = useNameIndex(!isDeleted ? uploadId : null, {
    enabled: !isDeleted,
    onError: handleFieldValuesError,
    onUploadDeleted: markDeleted,
    onVersionObserved: observeVersion,
  });
  const handleMissingBitmap = useCallback(
    (message: string) => {
      showToast(message, "error");
      void setCountryTickCountry(null);
    },
    [showToast, setCountryTickCountry],
  );
  const handleCountError = useCallback(
    (message: string, err?: unknown) => {
      console.error("Failed to load filtered count:", err);
      showToast(message, "error");
    },
    [showToast],
  );
  const { count: filteredCount } = useFilteredCount(!isDeleted ? uploadId : null, {
    filterString: filterParam,
    tickFilterParam: effectiveTickFilterParam,
    yearTickYear,
    countryTickCountry,
    enabled: !isDeleted,
    onMissingBitmap: handleMissingBitmap,
    onError: handleCountError,
    onUploadDeleted: markDeleted,
    onVersionObserved: observeVersion,
  });
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
    if (yearsVersion) {
      observeVersion(yearsVersion);
    }
  }, [yearsVersion, observeVersion]);

  useEffect(() => {
    if (countriesVersion) {
      observeVersion(countriesVersion);
    }
  }, [countriesVersion, observeVersion]);

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
    if (typeof document !== "undefined") {
      document.title = `${resolvedTitle} | redgrou.se`;
    }
  }, [resolvedTitle]);

  const handleNavigateToSighting = useCallback(
    (sightingId: number, lat: number, lng: number) => {
      setViewMode("map");
      if (mapReady && navigateToLocationRef.current) {
        navigateToLocationRef.current(sightingId, lat, lng);
      }
    },
    [mapReady],
  );

  const handleMapReady = useCallback((navigateFn: (sightingId: number, lat: number, lng: number) => void) => {
    navigateToLocationRef.current = navigateFn;
    setMapReady(true);
  }, []);

  const handleRefresh = useCallback(async () => {
    try {
      const metadata = await refreshUploadMetadata();
      if (!metadata) {
        return;
      }
      setFilter(null);
      await refreshNameIndex().catch(() => null);
    } catch (err) {
      const message = getErrorMessage(err, "Failed to refresh upload");
      showToast(message, "error");
    }
  }, [refreshUploadMetadata, setFilter, refreshNameIndex, showToast]);

  const handleRenameComplete = useCallback(
    (metadata: UploadMetadata) => {
      applyRemoteMetadata(metadata);
    },
    [applyRemoteMetadata],
  );

  const showingFiltered =
    (filter ||
      tickMode !== "all" ||
      yearTickYear !== null ||
      countryTickCountry !== null) &&
    filteredCount !== null &&
    filteredCount !== upload.rowCount;


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
            onClick={handleRefresh}
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
      <main className="fixed inset-0 overflow-hidden">
      <div className="absolute inset-0">
        <SightingsMap
          uploadId={upload.uploadId}
          filter={filter}
          tickFilterParam={effectiveTickFilterParam}
          yearTickYear={yearTickYear}
          countryTickCountry={countryTickCountry}
          dataVersion={currentDataVersion}
          onRemoteVersionObserved={observeVersion}
          onUploadDeleted={markDeleted}
          onMapReady={handleMapReady}
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
              tickFilterParam={effectiveTickFilterParam}
              yearTickYear={yearTickYear}
              countryTickCountry={countryTickCountry}
              nameIndex={nameIndex}
              onNavigateToSighting={handleNavigateToSighting}
              onRemoteVersionObserved={observeVersion}
            onUploadDeleted={markDeleted}
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
        <TickControls
          tickButton={
            <ClientTickFilterButton
              tickIndicator={tickIndicator}
              tickMode={tickMode}
              onSelectMode={handleTickModeChange}
            />
          }
          availableYears={availableYears}
          selectedYear={yearTickYear}
          onYearChange={handleYearChange}
          availableCountries={availableCountries}
          selectedCountry={countryTickCountry}
          onCountryChange={handleCountryChange}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />

        <ActionsMenu
          uploadId={upload.uploadId}
          filename={upload.filename}
          title={resolvedTitle}
          rowCount={upload.rowCount}
          isFilterOpen={filterOpen}
          onToggleFilter={() => setFilterOpen((prev) => !prev)}
          filter={filter}
          editToken={editToken}
          onUpdateComplete={handleRefresh}
          onRenameComplete={handleRenameComplete}
        />
      </div>
    </main>
    </>
  );
}
