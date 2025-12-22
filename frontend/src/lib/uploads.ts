export function deriveTitleFromFilename(filename: string): string {
  if (filename.toLowerCase().endsWith(".csv") && filename.length > 4) {
    const trimmed = filename.slice(0, -4);
    return trimmed.length > 0 ? trimmed : filename;
  }
  return filename;
}

export const UPLOAD_EVENTS_CHANNEL = "redgrouse-upload-events";

export type UploadBroadcastEvent =
  | { type: "updated"; uploadId: string; dataVersion?: number }
  | { type: "deleted"; uploadId: string };

export function broadcastUploadEvent(event: UploadBroadcastEvent): void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return;
  }

  try {
    const channel = new BroadcastChannel(UPLOAD_EVENTS_CHANNEL);
    channel.postMessage(event);
    channel.close();
  } catch (err) {
    console.warn("Failed to broadcast upload event", err);
  }
}

