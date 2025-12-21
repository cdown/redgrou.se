"use client";

import { useState, useCallback } from "react";
import { Upload, FileText, AlertCircle } from "lucide-react";
import Link from "next/link";
import {
  apiFetch,
  checkApiResponse,
  getErrorMessage,
  parseProtoResponse,
} from "@/lib/api";
import { setEditToken } from "@/lib/storage";
import { UPLOAD_ROUTE } from "@/lib/generated/api_constants";
import type { UploadResponse as UploadResponseMessage } from "@/lib/proto/redgrouse_api";
import { UploadResponse as UploadResponseDecoder } from "@/lib/proto/redgrouse_api";

type UploadResult = UploadResponseMessage;

interface UploadFormProps {
  onUploadComplete: (result: UploadResult) => void;
}

export function UploadForm({ onUploadComplete }: UploadFormProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = useCallback(
    async (file: File) => {
      if (!file.name.endsWith(".csv")) {
        setError("Please upload a CSV file");
        return;
      }

      setIsUploading(true);
      setError(null);

      const formData = new FormData();
      formData.append("file", file);

      try {
        const res = await apiFetch(UPLOAD_ROUTE, {
          method: "POST",
          body: formData,
        });

        await checkApiResponse(res, "Upload failed");

        const result = await parseProtoResponse(res, UploadResponseDecoder);
        setEditToken(result.uploadId, result.editToken);
        onUploadComplete(result);
      } catch (err) {
        setError(getErrorMessage(err, "Upload failed"));
      } finally {
        setIsUploading(false);
      }
    },
    [onUploadComplete],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleUpload(file);
    },
    [handleUpload],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleUpload(file);
    },
    [handleUpload],
  );

  return (
    <div
      className={`rounded-xl border-2 border-dashed p-8 text-center transition-all ${
        isDragging
          ? "border-rose-400 bg-rose-50"
          : "border-stone-200 hover:border-stone-300"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {isUploading ? (
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-300 border-t-rose-500" />
          <p className="text-sm text-stone-500">Processing sightings...</p>
        </div>
      ) : (
        <>
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-stone-100">
            <Upload className="h-5 w-5 text-stone-500" />
          </div>
          <p className="mb-4 text-sm text-stone-600">
            Drag and drop your CSV file here, or
          </p>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-stone-800 hover:shadow-md active:scale-[0.98]">
            <FileText className="h-4 w-4" />
            Choose file
            <input
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileSelect}
            />
          </label>
          <p className="mt-3 text-xs text-stone-400">
            Supports CSV exports from Birda
          </p>
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-left">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="flex-1 space-y-1">
                <p className="text-xs font-medium text-amber-900">
                  Data storage notice
                </p>
                <p className="text-xs text-amber-800">
                  Your data will be uploaded and stored on our server in a
                  database. This includes location data (GPS coordinates) from
                  your sightings.{" "}
                  <Link
                    href="/privacy"
                    className="underline hover:text-amber-900"
                  >
                    Learn more
                  </Link>
                </p>
              </div>
            </div>
          </div>
        </>
      )}
      {error && (
        <p className="mt-4 text-sm font-medium text-rose-600">{error}</p>
      )}
    </div>
  );
}
