"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { apiFetch, buildApiUrl } from "@/lib/api";
import {
  getEditToken as getStoredEditToken,
  setEditToken as setStoredEditToken,
  removeEditToken,
} from "@/lib/storage";
import {
  Sparkles,
  MoreVertical,
  ChevronDown,
  X,
  Calendar,
  Map,
  List,
  Search,
  Check,
  Link,
  Edit,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { SightingsMap } from "@/components/sightings-map";
import { SightingsTable } from "@/components/sightings-table";
import { QueryBuilder } from "@/components/query-builder";
import { FilterGroup, filterToJson } from "@/lib/filter-types";
import {
  UPLOAD_DETAILS_ROUTE,
  UPLOAD_COUNT_ROUTE,
  FIELD_VALUES_ROUTE,
} from "@/lib/generated/api_constants";

type ViewMode = "map" | "table";

interface UploadMetadata {
  upload_id: string;
  filename: string;
  row_count: number;
}

function getEditToken(uploadId: string): string | null {
  if (typeof window === "undefined") return null;

  // Check URL parameter first (for edit links)
  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = urlParams.get("token");
  if (urlToken) return urlToken;

  return getStoredEditToken(uploadId);
}

export default function UploadPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const uploadId = params.uploadId as string;

  const [upload, setUpload] = useState<UploadMetadata | null>(null);
  const [filter, setFilter] = useState<FilterGroup | null>(null);
  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [filterOpen, setFilterOpen] = useState(false);
  const [lifersOnly, setLifersOnly] = useState(false);
  const [yearTickYear, setYearTickYear] = useState<number | null>(null);
  const [availableYears, setAvailableYears] = useState<number[]>([]);

  const [editToken, setEditToken] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [copiedEditLink, setCopiedEditLink] = useState(false);
  const [menuExpanded, setMenuExpanded] = useState(false);
  const [tableTopOffset, setTableTopOffset] = useState(200);
  const navigateToLocationRef = useRef<
    | ((
        lat: number,
        lng: number,
        sightingData?: {
          name: string;
          scientificName?: string | null;
          count: number;
        },
      ) => void)
    | null
  >(null);
  const [mapReady, setMapReady] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const topRightControlsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!uploadId) return;
    setEditToken(getEditToken(uploadId));
  }, [uploadId]);

  // Measure top-right controls height to position table overlay
  useEffect(() => {
    const updateTableTop = () => {
      if (topRightControlsRef.current) {
        const rect = topRightControlsRef.current.getBoundingClientRect();
        // Add some padding (16px = top-4) + gap (8px) for spacing
        setTableTopOffset(rect.bottom + 8);
      }
    };

    updateTableTop();
    window.addEventListener("resize", updateTableTop);
    return () => window.removeEventListener("resize", updateTableTop);
  }, [menuExpanded, availableYears.length]);

  // Store token from URL in localStorage, then remove from URL bar to prevent
  // accidental sharing of the edit link when user copies the URL
  useEffect(() => {
    const urlToken = searchParams.get("token");
    if (urlToken && uploadId) {
      setStoredEditToken(uploadId, urlToken);

      // Remove token from URL without triggering navigation
      const cleanUrl = `${window.location.origin}/single/${uploadId}`;
      window.history.replaceState({}, "", cleanUrl);
    }
  }, [searchParams, uploadId]);

  useEffect(() => {
    if (!uploadId) return;

    apiFetch(buildApiUrl(UPLOAD_DETAILS_ROUTE, { upload_id: uploadId }))
      .then((res) => {
        if (!res.ok) throw new Error("Upload not found");
        return res.json();
      })
      .then(setUpload)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

    // Fetch available years for year tick filter
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
          .sort((a, b) => b - a); // Sort descending (most recent first)
        setAvailableYears(years);
      })
      .catch(() => {
        // Ignore errors, just don't show year selector
      });
  }, [uploadId]);

  useEffect(() => {
    if (!uploadId || !filter) return;

    let cancelled = false;
    const filterParam = encodeURIComponent(filterToJson(filter));
    const url = `${buildApiUrl(UPLOAD_COUNT_ROUTE, { upload_id: uploadId })}?filter=${filterParam}`;

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
  }, [uploadId, filter]);

  const handleCopyLink = useCallback(async () => {
    const url = window.location.origin + "/single/" + uploadId;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setMenuExpanded(false);
    setTimeout(() => setCopied(false), 2000);
  }, [uploadId]);

  const handleCopyEditLink = useCallback(async () => {
    if (!editToken) return;
    const url = `${window.location.origin}/single/${uploadId}?token=${editToken}`;
    await navigator.clipboard.writeText(url);
    setCopiedEditLink(true);
    setMenuExpanded(false);
    setTimeout(() => setCopiedEditLink(false), 2000);
  }, [uploadId, editToken]);

  const handleDelete = useCallback(async () => {
    if (!editToken) return;

    setIsDeleting(true);
    try {
      const res = await apiFetch(
        buildApiUrl(UPLOAD_DETAILS_ROUTE, { upload_id: uploadId }),
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${editToken}`,
          },
        },
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Delete failed");
      }

      removeEditToken(uploadId);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setShowDeleteConfirm(false);
    } finally {
      setIsDeleting(false);
    }
  }, [editToken, uploadId, router]);

  const handleUpdate = useCallback(
    async (file: File) => {
      if (!editToken) return;

      setIsUpdating(true);
      setUpdateError(null);

      const formData = new FormData();
      formData.append("file", file);

      try {
        const res = await apiFetch(
          buildApiUrl(UPLOAD_DETAILS_ROUTE, { upload_id: uploadId }),
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${editToken}`,
            },
            body: formData,
          },
        );

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Update failed");
        }

        const result = await res.json();
        setUpload({
          upload_id: uploadId,
          filename: result.filename,
          row_count: result.row_count,
        });
        setShowUpdateModal(false);
        // Reset filter since data changed
        setFilter(null);
        setFilteredCount(null);
      } catch (err) {
        setUpdateError(err instanceof Error ? err.message : "Update failed");
      } finally {
        setIsUpdating(false);
      }
    },
    [editToken, uploadId],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        if (!file.name.endsWith(".csv")) {
          setUpdateError("Please select a CSV file");
          return;
        }
        handleUpdate(file);
      }
    },
    [handleUpdate],
  );

  if (loading) {
    return (
      <main className="fixed inset-0 flex items-center justify-center bg-stone-100">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-300 border-t-rose-500" />
          <p className="text-sm text-stone-500">Loading sightings...</p>
        </div>
      </main>
    );
  }

  if (error || !upload) {
    return (
      <main className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-stone-100">
        <div className="rounded-xl bg-white p-8 shadow-lg">
          <p className="mb-4 text-rose-600">{error || "Upload not found"}</p>
          <button
            onClick={() => router.push("/")}
            className="text-sm font-medium text-stone-600 hover:text-stone-900 transition-colors"
          >
            ← Upload your own data
          </button>
        </div>
      </main>
    );
  }

  const showingFiltered =
    filter && filteredCount !== null && filteredCount !== upload.row_count;
  const canEdit = !!editToken;

  return (
    <main className="fixed inset-0 overflow-hidden">
      {/* Full-screen map */}
      <div className="absolute inset-0">
        <SightingsMap
          uploadId={upload.upload_id}
          filter={filter}
          lifersOnly={lifersOnly}
          yearTickYear={yearTickYear}
          onMapReady={(navigateFn) => {
            navigateToLocationRef.current = navigateFn;
            setMapReady(true);
          }}
        />
      </div>

      {/* Table overlay (slides up from bottom when active) */}
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
              onNavigateToLocation={
                mapReady && navigateToLocationRef.current
                  ? (
                      lat: number,
                      lng: number,
                      sightingData?: {
                        name: string;
                        scientificName?: string | null;
                        count: number;
                      },
                    ) => {
                      setViewMode("map");
                      if (navigateToLocationRef.current) {
                        navigateToLocationRef.current(lat, lng, sightingData);
                      }
                    }
                  : undefined
              }
            />
          </div>
        </div>
      </div>

      {/* Filter panel (slides in from left) */}
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

      {/* Top-right: View controls */}
      <div
        ref={topRightControlsRef}
        className={`absolute right-4 top-4 flex flex-col gap-2 z-50 transition-opacity ${
          filterOpen ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
      >
        {/* Lifers and Year Tick filters - mutually exclusive */}
        <div className="flex gap-2">
          <button
            onClick={() => {
              const newLifersOnly = !lifersOnly;
              setLifersOnly(newLifersOnly);
              // Always clear year tick when enabling lifers to ensure mutual exclusivity
              // (If disabling, year tick should already be null, but clear it anyway to be safe)
              setYearTickYear(null);
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
                  // Always clear lifers when changing year tick to ensure mutual exclusivity
                  setLifersOnly(false);
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
        </div>

        {/* View toggle */}
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

        {/* More options */}
        <div className="flex flex-col overflow-hidden rounded-lg bg-white shadow-lg">
          <button
            onClick={() => setMenuExpanded(!menuExpanded)}
            className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <MoreVertical className="h-4 w-4" />
              <span>Actions</span>
            </div>
            <ChevronDown
              className={`h-4 w-4 transition-transform ${
                menuExpanded ? "rotate-180" : ""
              }`}
            />
          </button>

          {menuExpanded && (
            <>
              {!filterOpen && (
                <button
                  onClick={() => {
                    setFilterOpen(true);
                    setMenuExpanded(false);
                  }}
                  className="flex items-center gap-2 border-t px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
                >
                  <Search className="h-4 w-4" />
                  <span>Advanced filtering</span>
                  {filter && (
                    <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-xs font-medium text-white">
                      ✓
                    </span>
                  )}
                </button>
              )}
              <button
                onClick={handleCopyLink}
                className="flex items-center gap-2 border-t px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-500" />
                    <span className="text-emerald-600">Copied!</span>
                  </>
                ) : (
                  <>
                    <Link className="h-4 w-4" />
                    Copy link
                  </>
                )}
              </button>

              {canEdit && (
                <>
                  <button
                    onClick={handleCopyEditLink}
                    className="flex items-center gap-2 border-t px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
                  >
                    {copiedEditLink ? (
                      <>
                        <Check className="h-4 w-4 text-emerald-500" />
                        <span className="text-emerald-600">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Edit className="h-4 w-4" />
                        Copy edit link
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => {
                      setShowUpdateModal(true);
                      setMenuExpanded(false);
                    }}
                    className="flex items-center gap-2 border-t px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Replace data
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex items-center gap-2 border-t px-4 py-2.5 text-sm text-rose-600 hover:bg-rose-50 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </button>
                </>
              )}

              <button
                onClick={() => {
                  router.push("/");
                  setMenuExpanded(false);
                }}
                className="flex items-center gap-2 border-t px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
              >
                <Upload className="h-4 w-4" />
                Upload new
              </button>
            </>
          )}
        </div>
      </div>

      {/* Bottom-left: Brand */}
      <div className="absolute bottom-4 left-4 flex flex-col gap-2">
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-tight text-stone-600 drop-shadow-sm">
            redgrouse
          </span>
          <a
            href="https://chrisdown.name"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] tracking-[0.2em] text-stone-400 hover:text-stone-600 transition-colors"
          >
            by chris down
          </a>
        </div>
      </div>

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="mb-2 text-lg font-semibold text-stone-900">
              Delete this upload?
            </h3>
            <p className="mb-6 text-sm text-stone-600">
              This will permanently delete all{" "}
              {upload.row_count.toLocaleString()} sightings from{" "}
              <strong>{upload.filename}</strong>. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
                className="rounded-lg px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 transition-colors disabled:opacity-50"
              >
                {isDeleting ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Deleting...
                  </>
                ) : (
                  "Delete"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Update modal */}
      {showUpdateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="mb-2 text-lg font-semibold text-stone-900">
              Replace data
            </h3>
            <p className="mb-6 text-sm text-stone-600">
              Upload a new CSV file to replace all existing sightings. The URL
              will remain the same.
            </p>

            {updateError && (
              <p className="mb-4 text-sm font-medium text-rose-600">
                {updateError}
              </p>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileSelect}
            />

            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowUpdateModal(false);
                  setUpdateError(null);
                }}
                disabled={isUpdating}
                className="rounded-lg px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isUpdating}
                className="flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors disabled:opacity-50"
              >
                {isUpdating ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    Choose file
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
