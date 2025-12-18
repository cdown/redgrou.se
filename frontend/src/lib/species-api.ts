export interface SpeciesInfo {
  scientificName: string;
  commonName: string;
  wikipediaSummary: string | null;
  photoUrl: string | null;
  photoAttribution: string | null;
  inaturalistUrl: string;
  observationsCount: number | null;
}

interface INatTaxaResponse {
  results: INatTaxon[];
}

interface INatTaxon {
  id: number;
  name: string;
  preferred_common_name?: string;
  wikipedia_summary?: string;
  observations_count?: number;
  default_photo?: {
    medium_url?: string;
    attribution?: string;
  };
}

const cache = new Map<string, SpeciesInfo>();

// This is a dirty hack. iNaturalist's API claims to return UTF-8 JSON (which
// is... normal), but somewhere in their pipeline they're mangling author names
// in photo attribution fields. What's happening is they have UTF-8 strings
// like "Pétur" but they're treating those UTF-8 bytes as if they were
// Latin-1/ISO-8859-1 (or *shudder* Windows-1252), so 0xC3 becomes "Ã" and 0xA9
// becomes "©", resulting in "PÃ©tur". Then they encode that mangled string as
// UTF-8 in their JSON response. This is also broken in their own UI, so it's
// not our problem, but we can at least fix it on our end.
//
// Good god, my eyes...
function unmangleINaturalistAuthorEncoding(str: string): string {
  // Windows-1252 characters to map, holes are marked with nulls
  const win1252 =
    "€\x00‚ƒ„…†‡ˆ‰Š‹Œ\x00Ž\x00\x00\u2018\u2019\u201C\u201D•–—˜™š›œ\x00žŸ";

  try {
    const bytes = Uint8Array.from(str, (char) => {
      const code = char.charCodeAt(0);
      // If it's a standard Latin-1 char, use it.
      if (code <= 0xff) return code;

      // If it's a Windows-1252 char, find its byte value by index + 0x80
      const index = win1252.indexOf(char);
      if (index > -1) return 0x80 + index;

      // If it's neither, let's just return the string unmolested
      throw new Error();
    });

    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return str;
  }
}

export async function fetchSpeciesInfo(
  speciesName: string,
): Promise<SpeciesInfo | null> {
  const cacheKey = speciesName.toLowerCase();
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  try {
    const autocompleteUrl = `https://api.inaturalist.org/v1/taxa/autocomplete?q=${encodeURIComponent(speciesName)}&per_page=1&is_active=true`;
    const autocompleteRes = await fetch(autocompleteUrl);
    if (!autocompleteRes.ok) return null;

    const autocompleteData: INatTaxaResponse = await autocompleteRes.json();
    const taxon = autocompleteData.results[0];
    if (!taxon) return null;

    const fullUrl = `https://api.inaturalist.org/v1/taxa/${taxon.id}`;
    const fullRes = await fetch(fullUrl);
    if (!fullRes.ok) return null;

    const fullData: INatTaxaResponse = await fullRes.json();
    const fullTaxon = fullData.results[0];
    if (!fullTaxon) return null;

    const info: SpeciesInfo = {
      scientificName: fullTaxon.name,
      commonName: fullTaxon.preferred_common_name || speciesName,
      wikipediaSummary: fullTaxon.wikipedia_summary || null,
      photoUrl: fullTaxon.default_photo?.medium_url || null,
      photoAttribution: fullTaxon.default_photo?.attribution
        ? unmangleINaturalistAuthorEncoding(fullTaxon.default_photo.attribution)
        : null,
      inaturalistUrl: `https://www.inaturalist.org/taxa/${fullTaxon.id}`,
      observationsCount: fullTaxon.observations_count || null,
    };

    cache.set(cacheKey, info);
    return info;
  } catch (err) {
    console.error("Failed to fetch species info:", err, speciesName);
    return null;
  }
}
