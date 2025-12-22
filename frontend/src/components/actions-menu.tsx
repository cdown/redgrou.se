"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  MoreVertical,
  ChevronDown,
  Search,
  Check,
  Link,
  Edit,
  RefreshCw,
  Trash2,
  Upload,
  Info,
  Github,
  Type,
} from "lucide-react";
import { removeEditToken } from "@/lib/storage";
import { useToast } from "@/components/ui/toast";
import {
  apiFetch,
  buildApiUrl,
  checkApiResponse,
  getErrorMessage,
  parseProtoResponse,
} from "@/lib/api";
import { VERSION_ROUTE, UPLOAD_DETAILS_ROUTE } from "@/lib/generated/api_constants";
import {
  VersionInfo as VersionInfoDecoder,
  UploadMetadata as UploadMetadataDecoder,
  UpdateResponse as UpdateResponseDecoder,
} from "@/lib/proto/redgrouse_api";
import { FilterGroup } from "@/lib/filter-types";
import type { UploadMetadata as UploadMetadataMessage } from "@/lib/proto/redgrouse_api";
import { sanitizeText } from "@/lib/sanitize";
import { broadcastUploadEvent } from "@/lib/uploads";

interface ActionsMenuProps {
  uploadId: string;
  filename: string;
  title: string;
  rowCount: number;
  isFilterOpen: boolean;
  onToggleFilter: () => void;
  filter: FilterGroup | null;
  editToken: string | null;
  onUpdateComplete?: () => void;
  onRenameComplete?: (metadata: UploadMetadataMessage) => void;
}

export function ActionsMenu({
  uploadId,
  filename,
  title,
  rowCount,
  isFilterOpen,
  onToggleFilter,
  filter,
  editToken,
  onUpdateComplete,
  onRenameComplete,
}: ActionsMenuProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [menuExpanded, setMenuExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedEditLink, setCopiedEditLink] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [showPublicLinkWarning, setShowPublicLinkWarning] = useState(false);
  const [showEditLinkWarning, setShowEditLinkWarning] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState(title);
  const [backendVersion, setBackendVersion] = useState<{
    gitHash: string;
    buildDate: string;
    rustcVersion: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const safeTitle = sanitizeText(title);
  const safeFilename = sanitizeText(filename);

  useEffect(() => {
    setRenameValue(title);
  }, [title]);

  const renameCharCount = renameValue.trim().length;
  const renameDisabled =
    renameCharCount === 0 || renameCharCount > 128 || !editToken;

  const handleCopyLink = useCallback(() => {
    setShowPublicLinkWarning(true);
    setMenuExpanded(false);
  }, []);

  const confirmCopyLink = useCallback(async () => {
    const url = window.location.origin + "/single/" + uploadId;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setShowPublicLinkWarning(false);
    setTimeout(() => setCopied(false), 2000);
  }, [uploadId]);

  const handleCopyEditLink = useCallback(() => {
    if (!editToken) return;
    setShowEditLinkWarning(true);
    setMenuExpanded(false);
  }, [editToken]);

  const confirmCopyEditLink = useCallback(async () => {
    if (!editToken) return;
    const url = `${window.location.origin}/single/${uploadId}?token=${editToken}`;
    await navigator.clipboard.writeText(url);
    setCopiedEditLink(true);
    setShowEditLinkWarning(false);
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

      await checkApiResponse(res, "Delete failed");

      broadcastUploadEvent({ type: "deleted", uploadId });
      removeEditToken(uploadId);
      router.push("/");
    } catch (err) {
      const message = getErrorMessage(err, "Delete failed");
      console.error(message);
      showToast(message, "error");
    } finally {
      setIsDeleting(false);
    }
  }, [editToken, uploadId, router, showToast]);

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

        await checkApiResponse(res, "Update failed");
        const updateData = await parseProtoResponse(res, UpdateResponseDecoder);

        setShowUpdateModal(false);
        if (onUpdateComplete) {
          onUpdateComplete();
        }
        broadcastUploadEvent({
          type: "updated",
          uploadId,
          dataVersion: updateData.dataVersion,
        });
      } catch (err) {
        setUpdateError(getErrorMessage(err, "Update failed"));
      } finally {
        setIsUpdating(false);
      }
    },
    [editToken, uploadId, onUpdateComplete],
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

  const handleRenameSubmit = useCallback(async () => {
    if (!editToken) return;
    const trimmed = renameValue.trim();
    if (trimmed.length === 0) {
      setRenameError("Name cannot be empty");
      return;
    }
    if (trimmed.length > 128) {
      setRenameError("Name must be at most 128 characters");
      return;
    }

    setIsRenaming(true);
    setRenameError(null);

    try {
      const res = await apiFetch(
        buildApiUrl(UPLOAD_DETAILS_ROUTE, { upload_id: uploadId }),
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${editToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ display_name: trimmed }),
        },
      );

      await checkApiResponse(res, "Rename failed");
      const metadata = await parseProtoResponse(res, UploadMetadataDecoder);
      onRenameComplete?.(metadata);
      broadcastUploadEvent({
        type: "updated",
        uploadId,
        dataVersion: metadata.dataVersion,
      });
      setShowRenameModal(false);
    } catch (err) {
      setRenameError(getErrorMessage(err, "Rename failed"));
    } finally {
      setIsRenaming(false);
    }
  }, [editToken, uploadId, renameValue, onRenameComplete]);

  return (
    <>
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
            {!isFilterOpen && (
              <button
                onClick={() => {
                  onToggleFilter();
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

            {editToken && (
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
                    setRenameValue(title);
                    setRenameError(null);
                    setShowRenameModal(true);
                    setMenuExpanded(false);
                  }}
                  className="flex items-center gap-2 border-t px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
                >
                  <Type className="h-4 w-4" />
                  Rename upload
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
            <button
              onClick={() => {
                setShowAboutModal(true);
                setMenuExpanded(false);
                if (!backendVersion) {
                  apiFetch(buildApiUrl(VERSION_ROUTE))
                    .then(async (res) => {
                      await checkApiResponse(res, "Failed to load version");
                      return parseProtoResponse(res, VersionInfoDecoder);
                    })
                    .then((data) => setBackendVersion(data))
                    .catch((err) => {
                      const message = getErrorMessage(err, "Failed to load version info");
                      console.error("Failed to fetch version info:", err);
                      showToast(message, "error");
                      setBackendVersion({
                        gitHash: "unknown",
                        buildDate: "unknown",
                        rustcVersion: "unknown",
                      });
                    });
                }
              }}
              className="flex items-center gap-2 border-t px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
            >
              <Info className="h-4 w-4" />
              About
            </button>
          </>
        )}
      </div>

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="mb-2 text-lg font-semibold text-stone-900">
              Delete this upload?
            </h3>
            <p className="mb-6 text-sm text-stone-600">
              This will permanently delete all{" "}
              {rowCount.toLocaleString()} sightings from{" "}
              <strong>{safeTitle}</strong>. This action cannot be undone.
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

      {showRenameModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="mb-2 text-lg font-semibold text-stone-900">
              Rename upload
            </h3>
            <p className="mb-4 text-sm text-stone-600">
              Choose a display name (max 128 characters).
            </p>
            <p className="mb-4 text-xs text-stone-500">
              Original file: {safeFilename}
            </p>
            {renameError && (
              <p className="mb-3 text-sm font-medium text-rose-600">
                {renameError}
              </p>
            )}
            <input
              type="text"
              maxLength={128}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900 focus:border-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-500"
              placeholder="e.g. Spring migration 2024"
              autoFocus
            />
            <div className="mt-2 text-right text-xs text-stone-500">
              {renameCharCount}/128
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowRenameModal(false);
                  setRenameError(null);
                }}
                disabled={isRenaming}
                className="rounded-lg px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRenameSubmit}
                disabled={renameDisabled || isRenaming}
                className="flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors disabled:opacity-50"
              >
                {isRenaming ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Saving...
                  </>
                ) : (
                  "Save"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAboutModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="mb-4 text-lg font-semibold text-stone-900">
              About redgrou.se
            </h3>
            <p className="mb-6 text-sm text-stone-600">
              A high-performance bird sighting analytics platform. Upload your
              sightings, explore them all on an interactive map, and filter by
              species, location, date, significance, and more.
            </p>

            <div className="mb-6 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-stone-500">Backend Git Hash:</span>
                {backendVersion?.gitHash &&
                backendVersion.gitHash !== "unknown" ? (
                  <a
                    href={`https://github.com/cdown/redgrou.se/commit/${backendVersion.gitHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-stone-900 underline hover:text-rose-600 transition-colors"
                  >
                    {backendVersion.gitHash}
                  </a>
                ) : (
                  <span className="font-mono text-stone-900">
                    {backendVersion?.gitHash || "Loading..."}
                  </span>
                )}
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500">Frontend Git Hash:</span>
                {process.env.NEXT_PUBLIC_BUILD_VERSION &&
                process.env.NEXT_PUBLIC_BUILD_VERSION !== "unknown" ? (
                  <a
                    href={`https://github.com/cdown/redgrou.se/commit/${process.env.NEXT_PUBLIC_BUILD_VERSION}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-stone-900 underline hover:text-rose-600 transition-colors"
                  >
                    {process.env.NEXT_PUBLIC_BUILD_VERSION}
                  </a>
                ) : (
                  <span className="font-mono text-stone-900">
                    {process.env.NEXT_PUBLIC_BUILD_VERSION || "unknown"}
                  </span>
                )}
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500">Build Date:</span>
                <span className="font-mono text-stone-900">
                  {backendVersion?.buildDate ||
                    process.env.NEXT_PUBLIC_BUILD_DATE ||
                    "unknown"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500">Rustc Version:</span>
                <span className="font-mono text-stone-900">
                  {backendVersion?.rustcVersion || "Loading..."}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500">Next.js Version:</span>
                <span className="font-mono text-stone-900">
                  {process.env.NEXT_PUBLIC_NEXTJS_VERSION || "unknown"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500">Node.js Version:</span>
                <span className="font-mono text-stone-900">
                  {process.env.NEXT_PUBLIC_NODE_VERSION || "unknown"}
                </span>
              </div>
            </div>

            <div className="flex justify-end">
              <a
                href="https://github.com/cdown/redgrou.se"
                target="_blank"
                rel="noopener noreferrer"
                className="mr-3 flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100 transition-colors"
              >
                <Github className="h-4 w-4" />
                View on GitHub
              </a>
              <button
                onClick={() => setShowAboutModal(false)}
                className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showPublicLinkWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="mb-2 text-lg font-semibold text-stone-900">
              Share public link?
            </h3>
            <p className="mb-6 text-sm text-stone-600">
              This link grants <strong>public read access</strong> to your
              location history. Anyone with the link can view all your
              sightings and their GPS coordinates without authentication.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowPublicLinkWarning(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmCopyLink}
                className="flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
              >
                <Link className="h-4 w-4" />
                Copy link
              </button>
            </div>
          </div>
        </div>
      )}

      {showEditLinkWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="mb-2 text-lg font-semibold text-stone-900">
              Share edit link?
            </h3>
            <p className="mb-6 text-sm text-stone-600">
              This link includes your <strong>authentication credentials</strong>
              . Anyone with this link can edit, rename, replace, or delete your
              upload. Only share this link with people you trust.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowEditLinkWarning(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmCopyEditLink}
                className="flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition-colors"
              >
                <Edit className="h-4 w-4" />
                Copy edit link
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
