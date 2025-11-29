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

  const serverVersion = response.headers.get("x-build-version");
  if (!serverVersion || serverVersion === "unknown" || BUILD_VERSION === "unknown") {
    return;
  }

  if (serverVersion !== BUILD_VERSION) {
    versionMismatchDetected = true;
    callbacks.forEach((cb) => cb());
  }
}
