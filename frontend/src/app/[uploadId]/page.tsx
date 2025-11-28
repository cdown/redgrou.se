"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { SightingsMap } from "@/components/sightings-map";
import { QueryBuilder } from "@/components/query-builder";
import { FilterGroup, filterToJson } from "@/lib/filter-types";

interface UploadMetadata {
  upload_id: string;
  filename: string;
  row_count: number;
}

export default function UploadPage() {
  const params = useParams();
  const router = useRouter();
  const uploadId = params.uploadId as string;

  const [upload, setUpload] = useState<UploadMetadata | null>(null);
  const [filter, setFilter] = useState<FilterGroup | null>(null);
  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!uploadId) return;

    fetch(`http://localhost:3001/api/uploads/${uploadId}`)
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

    const filterParam = encodeURIComponent(filterToJson(filter));
    fetch(`http://localhost:3001/api/uploads/${uploadId}/count?filter=${filterParam}`)
      .then((res) => res.json())
      .then((data) => setFilteredCount(data.count))
      .catch(() => setFilteredCount(null));
  }, [uploadId, filter]);

  const handleCopyLink = async () => {
    const url = window.location.href;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <main className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </main>
    );
  }

  if (error || !upload) {
    return (
      <main className="flex h-screen flex-col items-center justify-center gap-4">
        <p className="text-destructive">
          {error || "Upload not found"}
        </p>
        <button
          onClick={() => router.push("/")}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Upload your own data
        </button>
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="font-semibold">redgrou.se</h1>
            <p className="text-sm text-muted-foreground">
              {upload.filename} — {upload.row_count.toLocaleString()} sightings
              {filter && filteredCount !== null && filteredCount !== upload.row_count && (
                <span className="text-foreground font-medium">
                  {" "}(showing {filteredCount.toLocaleString()})
                </span>
              )}
            </p>
          </div>
          <QueryBuilder uploadId={upload.upload_id} onFilterChange={setFilter} />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleCopyLink}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            {copied ? (
              <>
                <span className="text-green-600">✓</span>
                Copied!
              </>
            ) : (
              <>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
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
          <button
            onClick={() => router.push("/")}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Upload another
          </button>
        </div>
      </header>
      <div className="flex-1">
        <SightingsMap uploadId={upload.upload_id} filter={filter} />
      </div>
    </main>
  );
}
