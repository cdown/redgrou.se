import { checkVersionHeader } from "./version-check";

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
