"use client";

import { useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import { subscribeToVersionMismatch } from "@/lib/version-check";

let mismatchDetected = false;

function subscribe(callback: () => void): () => void {
  return subscribeToVersionMismatch(() => {
    mismatchDetected = true;
    callback();
  });
}

function getSnapshot(): boolean {
  return mismatchDetected;
}

function getServerSnapshot(): boolean {
  return false;
}

export function VersionBanner() {
  const showBanner = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (!showBanner) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] bg-amber-500 text-amber-950 px-4 py-2 text-center text-sm font-medium flex items-center justify-center gap-2">
      <RefreshCw className="h-4 w-4" />
      <span>A new version is available.</span>
      <button
        onClick={() => window.location.reload()}
        className="underline hover:no-underline font-semibold"
      >
        Refresh now
      </button>
    </div>
  );
}
