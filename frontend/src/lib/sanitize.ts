import DOMPurify from "isomorphic-dompurify";

const TEXT_ONLY_CONFIG = Object.freeze({
  ALLOWED_TAGS: [],
  ALLOWED_ATTR: [],
});

export function sanitizeText(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined) {
    return "";
  }
  return DOMPurify.sanitize(String(value), TEXT_ONLY_CONFIG);
}

export function sanitizeUrl(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch {
    return null;
  }

  return null;
}
