"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { SightingsMap } from "@/components/sightings-map";
import { SightingsTable } from "@/components/sightings-table";
import { QueryBuilder } from "@/components/query-builder";
import { FilterGroup, filterToJson } from "@/lib/filter-types";

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

  // Check localStorage
  const editTokens = JSON.parse(localStorage.getItem("editTokens") || "{}");
  return editTokens[uploadId] || null;
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

  const [editToken, setEditToken] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [copiedEditLink, setCopiedEditLink] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!uploadId) return;
    setEditToken(getEditToken(uploadId));
  }, [uploadId]);

  // Store token from URL in localStorage, then remove from URL bar to prevent
  // accidental sharing of the edit link when user copies the URL
  useEffect(() => {
    const urlToken = searchParams.get("token");
    if (urlToken && uploadId) {
      const editTokens = JSON.parse(localStorage.getItem("editTokens") || "{}");
      editTokens[uploadId] = urlToken;
      localStorage.setItem("editTokens", JSON.stringify(editTokens));

      // Remove token from URL without triggering navigation
      const cleanUrl = `${window.location.origin}/${uploadId}`;
      window.history.replaceState({}, "", cleanUrl);
    }
  }, [searchParams, uploadId]);

  useEffect(() => {
    if (!uploadId) return;

    apiFetch(`/api/uploads/${uploadId}`)
      .then((res) => {
        if (!res.ok) throw new Error("Upload not found");
        return res.json();
      })
      .then(setUpload)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [uploadId]);

  useEffect(() => {
    if (!uploadId || !filter) return;

    let cancelled = false;
    const filterParam = encodeURIComponent(filterToJson(filter));
    apiFetch(`/api/uploads/${uploadId}/count?filter=${filterParam}`)
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
    const url = window.location.origin + "/" + uploadId;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [uploadId]);

  const handleCopyEditLink = useCallback(async () => {
    if (!editToken) return;
    const url = `${window.location.origin}/${uploadId}?token=${editToken}`;
    await navigator.clipboard.writeText(url);
    setCopiedEditLink(true);
    setTimeout(() => setCopiedEditLink(false), 2000);
  }, [uploadId, editToken]);

  const handleDelete = useCallback(async () => {
    if (!editToken) return;

    setIsDeleting(true);
    try {
      const res = await apiFetch(`/api/uploads/${uploadId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${editToken}`,
        },
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Delete failed");
      }

      // Remove from localStorage
      const editTokens = JSON.parse(localStorage.getItem("editTokens") || "{}");
      delete editTokens[uploadId];
      localStorage.setItem("editTokens", JSON.stringify(editTokens));

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
        const res = await apiFetch(`/api/uploads/${uploadId}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${editToken}`,
          },
          body: formData,
        });

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
    [editToken, uploadId]
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
    [handleUpdate]
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
        <SightingsMap uploadId={upload.upload_id} filter={filter} />
      </div>

      {/* Table overlay (slides up from bottom when active) */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-white shadow-2xl transition-transform duration-300 ease-out ${
          viewMode === "table" ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ top: "80px", borderRadius: "16px 16px 0 0" }}
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
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
          <div className="relative flex-1 overflow-hidden">
            <SightingsTable uploadId={upload.upload_id} filter={filter} />
          </div>
        </div>
      </div>

      {/* Filter panel (slides in from left) */}
      <div
        className={`absolute bottom-4 left-4 top-4 w-[400px] overflow-hidden rounded-2xl bg-white shadow-2xl transition-transform duration-300 ease-out ${
          filterOpen ? "translate-x-0" : "-translate-x-[calc(100%+32px)]"
        }`}
      >
        <QueryBuilder
          uploadId={upload.upload_id}
          onFilterChange={setFilter}
          onClose={() => setFilterOpen(false)}
          isPanel
        />
      </div>

      {/* Top-left: Logo + Search button */}
      <div className="absolute left-4 top-4 flex flex-col gap-2">
        {!filterOpen && (
          <>
            <button
              onClick={() => setFilterOpen(true)}
              className="flex items-center gap-3 rounded-full bg-white px-4 py-3 shadow-lg hover:shadow-xl transition-shadow"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-stone-500"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <span className="text-stone-500">Filter sightings...</span>
              {filter && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-xs font-medium text-white">
                  ✓
                </span>
              )}
            </button>
          </>
        )}
      </div>

      {/* Top-right: View controls */}
      <div className="absolute right-4 top-4 flex flex-col gap-2">
        {/* View toggle */}
        <div className="flex overflow-hidden rounded-lg bg-white shadow-lg">
          <button
            onClick={() => setViewMode("map")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              viewMode === "map"
                ? "bg-stone-900 text-white"
                : "text-stone-600 hover:bg-stone-50"
            }`}
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
              <path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" />
              <path d="M15 5.764v15" />
              <path d="M9 3.236v15" />
            </svg>
            Map
          </button>
          <button
            onClick={() => setViewMode("table")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              viewMode === "table"
                ? "bg-stone-900 text-white"
                : "text-stone-600 hover:bg-stone-50"
            }`}
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
              <path d="M12 3v18" />
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M3 9h18" />
              <path d="M3 15h18" />
            </svg>
            List
          </button>
        </div>

        {/* More options */}
        <div className="flex flex-col overflow-hidden rounded-lg bg-white shadow-lg">
          <button
            onClick={handleCopyLink}
            className="flex items-center gap-2 px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
          >
            {copied ? (
              <>
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
                  className="text-emerald-500"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span className="text-emerald-600">Copied!</span>
              </>
            ) : (
              <>
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
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
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
                      className="text-emerald-500"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    <span className="text-emerald-600">Copied!</span>
                  </>
                ) : (
                  <>
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
                      <circle cx="7.5" cy="15.5" r="5.5" />
                      <path d="m21 2-9.6 9.6" />
                      <path d="m15.5 7.5 3 3L22 7l-3-3" />
                    </svg>
                    Copy edit link
                  </>
                )}
              </button>
              <button
                onClick={() => setShowUpdateModal(true)}
                className="flex items-center gap-2 border-t px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
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
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                  <path d="M16 16h5v5" />
                </svg>
                Replace data
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-2 border-t px-4 py-2.5 text-sm text-rose-600 hover:bg-rose-50 transition-colors"
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
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  <line x1="10" x2="10" y1="11" y2="17" />
                  <line x1="14" x2="14" y1="11" y2="17" />
                </svg>
                Delete
              </button>
            </>
          )}

          <button
            onClick={() => router.push("/")}
            className="flex items-center gap-2 border-t px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
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
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" x2="12" y1="3" y2="15" />
            </svg>
            Upload new
          </button>
        </div>
      </div>

      {/* Bottom-left: Stats pill */}
      <div className="absolute bottom-4 left-4">
        {!filterOpen && (
          <div className="rounded-full bg-white/95 px-4 py-2 text-sm shadow-lg backdrop-blur">
            <span className="font-medium text-stone-900">
              {showingFiltered
                ? `${filteredCount?.toLocaleString()} of ${upload.row_count.toLocaleString()}`
                : upload.row_count.toLocaleString()}
            </span>
            <span className="text-stone-500"> sightings</span>
            {upload.filename && (
              <span className="text-stone-400"> · {upload.filename}</span>
            )}
          </div>
        )}
      </div>

      {/* Bottom-right: Brand */}
      <div className="absolute bottom-4 right-4">
        <div className="rounded-lg bg-white/80 px-3 py-1.5 text-xs font-medium tracking-wide text-stone-500 shadow backdrop-blur">
          redgrou.se
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
              This will permanently delete all {upload.row_count.toLocaleString()}{" "}
              sightings from <strong>{upload.filename}</strong>. This action
              cannot be undone.
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
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" x2="12" y1="3" y2="15" />
                    </svg>
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
