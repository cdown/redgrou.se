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
      photoAttribution: fullTaxon.default_photo?.attribution || null,
      inaturalistUrl: `https://www.inaturalist.org/taxa/${fullTaxon.id}`,
      observationsCount: fullTaxon.observations_count || null,
    };

    cache.set(cacheKey, info);
    return info;
  } catch {
    return null;
  }
}
