"use client";

import { useRouter } from "next/navigation";
import { UploadForm } from "@/components/upload-form";

export default function Home() {
  const router = useRouter();

  return (
    <main className="flex h-screen flex-col">
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-md">
          <h1 className="mb-6 text-2xl font-semibold tracking-tight">
            redgrou.se
          </h1>
          <p className="mb-6 text-muted-foreground">
            Upload your bird sighting data to visualise on a map.
          </p>
          <UploadForm
            onUploadComplete={(result) => router.push(`/${result.upload_id}`)}
          />
        </div>
      </div>
    </main>
  );
}
