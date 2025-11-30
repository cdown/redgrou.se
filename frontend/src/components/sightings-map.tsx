"use client";

import { useRef, useEffect } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { getApiUrl, buildApiUrl } from "@/lib/api";
import { FilterGroup, filterToJson } from "@/lib/filter-types";
import { fetchSpeciesInfo } from "@/lib/species-api";
import { TILE_ROUTE } from "@/lib/generated/api_constants";
import { sanitizeText, sanitizeUrl } from "@/lib/sanitize";

interface SightingsMapProps {
  uploadId: string;
  filter: FilterGroup | null;
  lifersOnly: boolean;
  yearTickYear: number | null;
  onMapReady?: (navigateToLocation: (lat: number, lng: number) => void) => void;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

const MAX_DESCRIPTION_LENGTH = 350;

/**
 * Format an ISO 8601 date string to a readable format
 */
function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateString;
  }
}

function firstParagraph(text: string): string {
  const stripped = stripHtml(text);
  const para = stripped.split(/\n\n|\r\n\r\n/)[0].trim();

  if (para.length <= MAX_DESCRIPTION_LENGTH) {
    return para;
  }

  // Text exceeds limit - find last complete sentence that fits
  const truncated = para.slice(0, MAX_DESCRIPTION_LENGTH);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
    truncated.lastIndexOf("."),
  );

  if (lastSentenceEnd > 0) {
    return para.slice(0, lastSentenceEnd + 1);
  }

  return truncated;
}

function createPopupContent(
  name: string,
  count: number,
  scientificName?: string,
): HTMLDivElement {
  const safeName = sanitizeText(name);
  const safeScientificName = sanitizeText(scientificName);

  const container = document.createElement("div");
  container.className = "species-popup";
  container.innerHTML = `
    <div style="width: 280px; font-family: system-ui, -apple-system, sans-serif;">
      <div style="padding: 12px; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 32px; height: 32px; border-radius: 6px; background: #f3f4f6; display: flex; align-items: center; justify-content: center;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 6v6l4 2"/>
            </svg>
          </div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; font-size: 15px; color: #111827; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${safeName}</div>
            ${
              scientificName
                ? `<div style="font-size: 13px; color: #6b7280; font-style: italic;">${safeScientificName}</div>`
                : ""
            }
          </div>
        </div>
        <div style="font-size: 13px; color: #6b7280;">Loading species info…</div>
      </div>
    </div>
  `;
  return container;
}

function updatePopupWithSpeciesInfo(
  container: HTMLDivElement,
  name: string,
  count: number,
  info: {
    scientificName: string;
    commonName: string;
    wikipediaSummary: string | null;
    photoUrl: string | null;
    photoAttribution: string | null;
    inaturalistUrl: string;
    observationsCount: number | null;
  } | null,
  observedAt?: string,
  isLifer?: boolean,
  isYearTick?: boolean,
): void {
  const safeName = sanitizeText(name);
  const safeCount = sanitizeText(count);
  const badges: string[] = [];
  if (isLifer) badges.push("Lifer");
  if (isYearTick) badges.push("Year Tick");

  if (!info) {
    const dateDisplay = observedAt ? formatDate(observedAt) : "";

    container.innerHTML = `
      <div style="width: 280px; font-family: system-ui, -apple-system, sans-serif;">
        <div style="padding: 12px;">
          <div style="font-weight: 600; font-size: 15px; color: #111827; margin-bottom: 4px;">${safeName}</div>
          <div style="font-size: 13px; color: #6b7280; margin-bottom: 8px;">Count: ${safeCount}</div>
          ${
            dateDisplay
              ? `
            <div style="display: flex; align-items: center; gap: 4px; font-size: 13px; color: #6b7280; margin-bottom: 4px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
              <span>${sanitizeText(dateDisplay)}</span>
            </div>
          `
              : ""
          }
          ${
            badges.length > 0
              ? `
            <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px;">
              ${
                isLifer
                  ? `
                <div style="display: flex; align-items: center; gap: 4px; padding: 2px 8px; background: #f3f4f6; border-radius: 4px; font-size: 12px; color: #374151;">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  <span>Lifer</span>
                </div>
              `
                  : ""
              }
              ${
                isYearTick
                  ? `
                <div style="display: flex; align-items: center; gap: 4px; padding: 2px 8px; background: #f3f4f6; border-radius: 4px; font-size: 12px; color: #374151;">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8" y1="2" x2="8" y2="6"/>
                    <line x1="3" y1="10" x2="21" y2="10"/>
                  </svg>
                  <span>Year Tick</span>
                </div>
              `
                  : ""
              }
            </div>
          `
              : ""
          }
        </div>
      </div>
    `;
    return;
  }

  const summary = info.wikipediaSummary
    ? firstParagraph(info.wikipediaSummary)
    : null;
  const safeSummary = summary ? sanitizeText(summary) : null;
  const safeCommonName = sanitizeText(info.commonName);
  const safeScientificInfoName = sanitizeText(info.scientificName);
  const safeAttribution = sanitizeText(info.photoAttribution);
  const safePhotoUrl = sanitizeUrl(info.photoUrl);
  const safeInatUrl = sanitizeUrl(info.inaturalistUrl);
  const safeDateDisplay = observedAt
    ? sanitizeText(formatDate(observedAt))
    : null;

  container.innerHTML = `
    <div style="width: 300px; font-family: system-ui, -apple-system, sans-serif; overflow: hidden; border-radius: 8px;">
      ${
        safePhotoUrl
          ? `<div style="position: relative;">
              <img
                src="${safePhotoUrl}"
                alt="${safeCommonName}"
                style="width: 100%; height: 160px; object-fit: cover; display: block;"
              />
              <div style="position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,0.7)); padding: 8px 12px;">
                <div style="font-weight: 600; font-size: 16px; color: white;">${safeCommonName}</div>
                <div style="font-size: 13px; color: rgba(255,255,255,0.85); font-style: italic;">${safeScientificInfoName}</div>
              </div>
            </div>`
          : `<div style="padding: 12px 12px 0;">
              <div style="font-weight: 600; font-size: 16px; color: #111827;">${safeCommonName}</div>
              <div style="font-size: 13px; color: #6b7280; font-style: italic;">${safeScientificInfoName}</div>
            </div>`
      }
      <div style="padding: 12px;">
        ${
          safeSummary
            ? `<p style="font-size: 13px; line-height: 1.5; color: #374151; margin: 0 0 10px;">${safeSummary}</p>`
            : ""
        }
        <div style="display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid #e5e7eb;">
          <div style="display: flex; gap: 12px; align-items: center; justify-content: space-between;">
            <div style="display: flex; gap: 12px; align-items: center;">
              <div style="display: flex; align-items: center; gap: 4px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>
                <span style="font-size: 12px; color: #6b7280;">Count: ${safeCount}</span>
              </div>
              ${
                safeDateDisplay
                  ? `
                <div style="display: flex; align-items: center; gap: 4px;">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8" y1="2" x2="8" y2="6"/>
                    <line x1="3" y1="10" x2="21" y2="10"/>
                  </svg>
                  <span style="font-size: 12px; color: #6b7280;">${safeDateDisplay}</span>
                </div>
              `
                  : ""
              }
            </div>
            ${
              safeInatUrl
                ? `<a href="${safeInatUrl}" target="_blank" rel="noopener noreferrer" style="font-size: 12px; color: #2563eb; text-decoration: none;">iNaturalist →</a>`
                : ""
            }
          </div>
          ${
            isLifer || isYearTick
              ? `
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
              ${
                isLifer
                  ? `
                <div style="display: flex; align-items: center; gap: 4px; padding: 2px 8px; background: #f3f4f6; border-radius: 4px; font-size: 12px; color: #374151;">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  <span>Lifer</span>
                </div>
              `
                  : ""
              }
              ${
                isYearTick
                  ? `
                <div style="display: flex; align-items: center; gap: 4px; padding: 2px 8px; background: #f3f4f6; border-radius: 4px; font-size: 12px; color: #374151;">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8" y1="2" x2="8" y2="6"/>
                    <line x1="3" y1="10" x2="21" y2="10"/>
                  </svg>
                  <span>Year Tick</span>
                </div>
              `
                  : ""
              }
            </div>
          `
              : ""
          }
        </div>
        ${
          safeAttribution
            ? `<div style="font-size: 10px; color: #9ca3af; margin-top: 8px;">Photo: ${safeAttribution}</div>`
            : ""
        }
      </div>
    </div>
  `;
}

/**
 * Shows a species popup on the map at the given coordinates.
 * Creates an initial popup with loading state, then fetches species info
 * and replaces it with the full content.
 */
function showSpeciesPopup(
  map: maplibregl.Map,
  lat: number,
  lng: number,
  name: string,
  count: number,
  scientificName?: string,
  observedAt?: string,
  isLifer?: boolean,
  isYearTick?: boolean,
): void {
  const popupContent = createPopupContent(name, count, scientificName);

  let popup = new maplibregl.Popup({
    maxWidth: "none",
    subpixelPositioning: false,
  })
    .setLngLat([lng, lat])
    .setDOMContent(popupContent)
    .addTo(map);

  fetchSpeciesInfo(name).then((info) => {
    if (popup.isOpen()) {
      // Don't update the existing popup's content in place — it results
      // in blurry text, presumably because MapLibre repositions the popup
      // with subpixel values when its size changes.
      popup.remove();
      const finalContent = document.createElement("div");
      finalContent.className = "species-popup";
      updatePopupWithSpeciesInfo(
        finalContent,
        name,
        count,
        info,
        observedAt,
        isLifer,
        isYearTick,
      );
      popup = new maplibregl.Popup({
        maxWidth: "none",
        subpixelPositioning: false,
      })
        .setLngLat([lng, lat])
        .setDOMContent(finalContent)
        .addTo(map);
    }
  });
}

/**
 * Build tile URL with filter parameters
 */
function buildTileUrl(
  uploadId: string,
  filter: FilterGroup | null,
  lifersOnly: boolean,
  yearTickYear: number | null,
): string {
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

  const queryString = params.toString();
  const filterParam = queryString ? `?${queryString}` : "";

  return getApiUrl(
    buildApiUrl(TILE_ROUTE, { upload_id: uploadId }) + ".pbf" + filterParam,
  );
}

/**
 * Add sightings layer and attach event handlers
 */
function addSightingsLayer(map: maplibregl.Map): void {
  if (map.getLayer("sightings-circles")) {
    return; // Layer already exists
  }

  map.addLayer({
    id: "sightings-circles",
    type: "circle",
    source: "sightings",
    "source-layer": "sightings",
    paint: {
      "circle-radius": 6,
      "circle-color": "#e63946",
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#fff",
    },
  });

  map.on("click", "sightings-circles", (e) => {
    if (!e.features?.length) return;
    const feature = e.features[0];
    const name = feature.properties?.name || "Unknown";
    const scientificName = feature.properties?.scientific_name;
    const count =
      typeof feature.properties?.count === "number"
        ? feature.properties.count
        : parseInt(feature.properties?.count?.toString() || "1", 10);
    const observedAt = feature.properties?.observed_at?.toString();
    const lifer = feature.properties?.lifer;
    const yearTick = feature.properties?.year_tick;
    const isLifer = lifer === 1 || lifer === "1" || lifer === true;
    const isYearTick = yearTick === 1 || yearTick === "1" || yearTick === true;
    const lngLat = e.lngLat;

    showSpeciesPopup(
      map,
      lngLat.lat,
      lngLat.lng,
      name,
      count,
      scientificName,
      observedAt,
      isLifer,
      isYearTick,
    );
  });

  map.on("mouseenter", "sightings-circles", () => {
    map.getCanvas().style.cursor = "pointer";
  });

  map.on("mouseleave", "sightings-circles", () => {
    map.getCanvas().style.cursor = "";
  });
}

export function SightingsMap({
  uploadId,
  filter,
  lifersOnly,
  yearTickYear,
  onMapReady,
}: SightingsMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const onMapReadyRef = useRef(onMapReady);

  // Update ref when prop changes
  useEffect(() => {
    onMapReadyRef.current = onMapReady;
  }, [onMapReady]);

  // Initialize map (only when uploadId changes)
  useEffect(() => {
    if (!containerRef.current) return;

    if (mapRef.current) {
      // Cancel all pending tile requests before removing the map
      abortControllersRef.current.forEach((controller) => {
        controller.abort();
      });
      abortControllersRef.current.clear();
      mapRef.current.remove();
      mapRef.current = null;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [
          {
            id: "osm",
            type: "raster",
            source: "osm",
          },
        ],
      },
      center: [0, 20],
      zoom: 2,
      pixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : 1,
      transformRequest: (
        url: string,
        resourceType?: maplibregl.ResourceType,
      ) => {
        // Only intercept vector tile requests for our sightings source
        if (
          resourceType === "Tile" &&
          url.includes(TILE_ROUTE.replace("{upload_id}", uploadId))
        ) {
          const controllersMap = abortControllersRef.current;
          // Cancel any existing request for this exact URL (same tile being re-requested)
          const existingController = controllersMap.get(url);
          if (existingController) {
            existingController.abort();
            controllersMap.delete(url);
          }

          // Create a new AbortController for this request
          const controller = new AbortController();
          controllersMap.set(url, controller);

          // Return RequestParameters with the abort signal
          // MapLibre will use this and will cancel it via the signal when the tile
          // is no longer needed (e.g., user has zoomed past it)
          return {
            url,
            signal: controller.signal,
          };
        }
        // For non-tile requests or other sources, return undefined to use default handling
        return undefined;
      },
    });

    // Track the current zoom level to cancel stale requests
    let currentZoom = map.getZoom();
    let zoomChangeTimeout: NodeJS.Timeout | null = null;
    const controllersMap = abortControllersRef.current;

    // Cancel stale tile requests when zoom/pan changes significantly
    const cancelStaleRequests = () => {
      const newZoom = map.getZoom();
      const zoomDiff = Math.abs(newZoom - currentZoom);

      // If zoom changed significantly (more than 2 levels), cancel all pending requests
      // as they're likely for tiles that are no longer needed
      if (zoomDiff > 2) {
        controllersMap.forEach((controller) => {
          controller.abort();
        });
        controllersMap.clear();
        currentZoom = newZoom;
      }
    };

    // Debounce cancellation to avoid cancelling during smooth zoom animations
    const handleMove = () => {
      if (zoomChangeTimeout) {
        clearTimeout(zoomChangeTimeout);
      }
      zoomChangeTimeout = setTimeout(cancelStaleRequests, 100);
    };

    map.on("zoom", handleMove);
    map.on("moveend", handleMove);

    // Clean up AbortControllers periodically to prevent memory leaks
    const cleanupInterval = setInterval(() => {
      if (controllersMap.size > 100) {
        // If we have too many controllers, clear old ones
        const entries = Array.from(controllersMap.entries());
        controllersMap.clear();
        entries.slice(-50).forEach(([url, controller]) => {
          controllersMap.set(url, controller);
        });
      }
    }, 5000);

    // Create navigation function that will be exposed to parent
    const createNavigateFunction = () => {
      return (
        lat: number,
        lng: number,
        sightingData?: {
          name: string;
          scientificName?: string | null;
          count: number;
        },
      ) => {
        // Validate coordinates are valid numbers
        if (
          typeof lat !== "number" ||
          typeof lng !== "number" ||
          isNaN(lat) ||
          isNaN(lng) ||
          !isFinite(lat) ||
          !isFinite(lng)
        ) {
          console.warn("Invalid coordinates for navigation:", { lat, lng });
          return;
        }

        // Validate coordinate ranges
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          console.warn("Coordinates out of valid range:", { lat, lng });
          return;
        }

        // Zoom level 15 is appropriate for a detailed view
        // Store sighting data for the idle handler
        const showPopup = () => {
          if (!sightingData) {
            console.warn("No sighting data provided for popup");
            return;
          }
          // When navigating from table, date/lifer/yearTick may not be available
          // so we pass undefined - the popup will simply not display those fields
          showSpeciesPopup(
            map,
            lat,
            lng,
            sightingData.name,
            sightingData.count,
            sightingData.scientificName || undefined,
            undefined, // observedAt - not available from table navigation
            undefined, // isLifer - not available from table navigation
            undefined, // isYearTick - not available from table navigation
          );
        };

        // Use one-time moveend listener to show popup after animation completes
        const handleMoveEnd = () => {
          map.off("moveend", handleMoveEnd);
          // Small delay to ensure tiles are loaded
          setTimeout(showPopup, 200);
        };
        map.once("moveend", handleMoveEnd);

        map.flyTo({
          center: [lng, lat],
          zoom: 15,
          duration: 1000,
        });
      };
    };

    // Add sightings source and layer when map loads
    map.on("load", () => {
      const tileUrl = buildTileUrl(uploadId, filter, lifersOnly, yearTickYear);

      map.addSource("sightings", {
        type: "vector",
        tiles: [tileUrl],
      });

      addSightingsLayer(map);

      // Expose navigation function to parent component when map loads
      if (onMapReadyRef.current) {
        onMapReadyRef.current(createNavigateFunction());
      }
    });

    mapRef.current = map;

    return () => {
      // Cancel all pending tile requests
      controllersMap.forEach((controller) => {
        controller.abort();
      });
      controllersMap.clear();
      if (zoomChangeTimeout) {
        clearTimeout(zoomChangeTimeout);
      }
      map.off("zoom", handleMove);
      map.off("moveend", handleMove);
      clearInterval(cleanupInterval);
      map.remove();
      mapRef.current = null;
    };
    // Filter props (filter, lifersOnly, yearTickYear) are intentionally omitted.
    // Map initialization only runs when uploadId changes. Filter changes are
    // handled by a separate effect that updates the tile source without
    // recreating the map, preserving the viewport.
  }, [uploadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update tile source when filters change (preserves viewport)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.loaded() || !map.getSource("sightings")) {
      return;
    }

    const tileUrl = buildTileUrl(uploadId, filter, lifersOnly, yearTickYear);
    const source = map.getSource("sightings") as maplibregl.VectorTileSource;

    // Check if URL actually changed
    if (source && source.tiles && source.tiles[0] === tileUrl) {
      return;
    }

    // Preserve current viewport
    const center = map.getCenter();
    const zoom = map.getZoom();
    const bearing = map.getBearing();
    const pitch = map.getPitch();

    // Remove layer first (it depends on the source)
    // Event handlers are automatically removed when layer is removed
    if (map.getLayer("sightings-circles")) {
      map.removeLayer("sightings-circles");
    }

    // Remove and re-add source with new tile URL
    map.removeSource("sightings");
    map.addSource("sightings", {
      type: "vector",
      tiles: [tileUrl],
    });

    // Re-add layer and event handlers
    addSightingsLayer(map);

    // Restore viewport immediately (map will not animate)
    map.jumpTo({
      center: center,
      zoom: zoom,
      bearing: bearing,
      pitch: pitch,
    });
  }, [uploadId, filter, lifersOnly, yearTickYear]);

  return <div ref={containerRef} className="h-full w-full" />;
}
