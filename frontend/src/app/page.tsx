"use client";

import { useState } from "react";
import { UploadForm } from "@/components/upload-form";
import { SightingsMap } from "@/components/sightings-map";

interface UploadResult {
  upload_id: string;
  filename: string;
  row_count: number;
}

export default function Home() {
  const [upload, setUpload] = useState<UploadResult | null>(null);

  return (
    <main className="flex h-screen flex-col">
      {!upload ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="w-full max-w-md">
            <h1 className="mb-6 text-2xl font-semibold tracking-tight">
              redgrou.se
            </h1>
            <p className="mb-6 text-muted-foreground">
              Upload your bird sighting data to visualise on a map.
            </p>
            <UploadForm onUploadComplete={setUpload} />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col">
          <header className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <h1 className="font-semibold">redgrou.se</h1>
              <p className="text-sm text-muted-foreground">
                {upload.filename} — {upload.row_count.toLocaleString()} sightings
              </p>
            </div>
            <button
              onClick={() => setUpload(null)}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Upload another
            </button>
          </header>
          <div className="flex-1">
            <SightingsMap uploadId={upload.upload_id} />
          </div>
        </div>
      )}
    </main>
  );
}
