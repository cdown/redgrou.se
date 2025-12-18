import iso3166 from "iso-3166-2";

/**
 * Format an ISO 3166-2 region code (e.g., "US-TX") to a readable name.
 * Uses the iso-3166-2 package to look up region names from the official ISO database.
 */
export function formatRegion(code: string | null | undefined): string {
  if (!code) return "—";

  try {
    const subdivision = iso3166.subdivision(code.toUpperCase());
    if (subdivision && subdivision.name) {
      // Some names come in local language with extra text (e.g., "Valenciana, Comunidad")
      // For cleaner display, extract the main part before the comma if present
      const name = subdivision.name.split(",")[0].trim();
      return name;
    }
  } catch (err) {
    console.error("Failed to format region code:", err, code);
    // Package might not have the code, fall through to fallback
  }

  // Fallback: extract and show subdivision code
  const parts = code.split("-");
  if (parts.length > 1) {
    return parts[1];
  }

  return code;
}
