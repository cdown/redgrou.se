const BUILD_VERSION = process.env.NEXT_PUBLIC_BUILD_VERSION || "unknown";

let versionMismatchDetected = false;
const callbacks: Set<() => void> = new Set();

export function subscribeToVersionMismatch(callback: () => void): () => void {
  callbacks.add(callback);
  if (versionMismatchDetected) {
    callback();
  }
  return () => callbacks.delete(callback);
}

export function checkVersionHeader(response: Response): void {
  if (versionMismatchDetected) return;

  const serverVersion = response.headers.get("x-build-version")?.trim();
  const clientVersion = BUILD_VERSION.trim();

  // Don't show mismatch if either version is missing or unknown
  // This prevents false positives when build info isn't available
  if (!serverVersion || serverVersion === "unknown" || clientVersion === "unknown") {
    return;
  }

  // Only show mismatch if both versions are valid and different
  if (serverVersion !== clientVersion) {
    versionMismatchDetected = true;
    callbacks.forEach((cb) => cb());
  }
}
