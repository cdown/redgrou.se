import { checkVersionHeader } from "./version-check";
import { FilterGroup, filterToJson } from "./filter-types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export async function apiFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;
  const response = await fetch(url, init);
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
  filter: FilterGroup | null,
  lifersOnly: boolean,
  yearTickYear: number | null,
  countryTickCountry: string | null
): URLSearchParams {
  const params = new URLSearchParams();
  if (filter) {
    params.set("filter", filterToJson(filter));
  }
  if (lifersOnly) {
    params.set("lifers_only", "true");
  }
  if (yearTickYear !== null) {
    params.set("year_tick_year", String(yearTickYear));
  }
  if (countryTickCountry !== null) {
    params.set("country_tick_country", countryTickCountry);
  }
  return params;
}
