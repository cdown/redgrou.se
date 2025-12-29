import { checkVersionHeader } from "./version-check";
import { ApiErrorBody } from "@/lib/proto/redgrouse_api";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
const PROTO_CONTENT_TYPE = "application/x-protobuf";

export async function apiFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", PROTO_CONTENT_TYPE);
  }
  const response = await fetch(
    url,
    init
      ? {
          ...init,
          headers,
        }
      : { headers }
  );
  checkVersionHeader(response);
  return response;
}

export function getApiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export function buildApiUrl(
  template: string,
  params: Record<string, string | number> = {}
): string {
  let url = template;
  for (const [key, value] of Object.entries(params)) {
    url = url.replace(`{${key}}`, String(value));
  }
  return url;
}

export function buildFilterParams(
  filterString: string | null,
  tickFilterParam: string | null,
  yearTickYear: number | null,
  countryTickCountry: string | null
): URLSearchParams {
  const params = new URLSearchParams();
  if (filterString) {
    params.set("filter", filterString);
  }
  if (tickFilterParam !== null) {
    params.set("tick_filter", tickFilterParam);
  }
  if (yearTickYear !== null) {
    params.set("year_tick_year", String(yearTickYear));
  }
  if (countryTickCountry !== null) {
    params.set("country_tick_country", countryTickCountry);
  }
  return params;
}

/**
 * Extracts error information from an API error response.
 * @param res - The fetch Response object
 * @param defaultMessage - Default error message if API doesn't provide one
 * @returns Object with error message and code
 */
export async function getApiErrorInfo(
  res: Response,
  defaultMessage: string
): Promise<{ message: string; code?: string }> {
  let message = defaultMessage;
  let code: string | undefined;
  try {
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 0) {
      const data = ApiErrorBody.decode(new Uint8Array(buffer));
      message = data.error || defaultMessage;
      code = data.code;
    }
  } catch {
    message = defaultMessage;
  }
  return { message, code };
}

/**
 * Checks if a response is OK and throws an error with the API error message if not.
 * @param res - The fetch Response object
 * @param defaultMessage - Default error message if API doesn't provide one
 * @throws Error with the API error message or defaultMessage. The error has an `apiErrorCode` property if available.
 */
export async function checkApiResponse(
  res: Response,
  defaultMessage: string
): Promise<void> {
  if (!res.ok) {
    const { message, code } = await getApiErrorInfo(res, defaultMessage);
    const error = new Error(message) as ApiError;
    if (code) {
      error.apiErrorCode = code;
    }
    throw error;
  }
}

/**
 * Error with optional API error code attached
 */
export interface ApiError extends Error {
  apiErrorCode?: string;
}

/**
 * Extracts an error message from a caught error, falling back to a default.
 * @param err - The caught error
 * @param defaultMessage - Default error message if err is not an Error
 * @returns The error message
 */
export function getErrorMessage(err: unknown, defaultMessage: string): string {
  return err instanceof Error ? err.message : defaultMessage;
}

export async function parseProtoResponse<T>(
  res: Response,
  decoder: { decode: (input: Uint8Array) => T }
): Promise<T> {
  const buffer = await res.arrayBuffer();
  return decoder.decode(new Uint8Array(buffer));
}
