"use client";

import { useRef, useEffect } from "react";
import { createRoot, Root } from "react-dom/client";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { getApiUrl, buildApiUrl } from "@/lib/api";
import { FilterGroup, filterToJson } from "@/lib/filter-types";
import { fetchSpeciesInfo } from "@/lib/species-api";
import { TILE_ROUTE } from "@/lib/generated/api_constants";
import { SpeciesPopup, SpeciesPopupLoading } from "@/components/species-popup";

interface SightingsMapProps {
  uploadId: string;
  filter: FilterGroup | null;
  lifersOnly: boolean;
  yearTickYear: number | null;
  onMapReady?: (navigateToLocation: (lat: number, lng: number) => void) => void;
}

function createPopupContent(
  name: string,
  count: number,
  scientificName?: string,
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  container.className = "species-popup";
  const root = createRoot(container);
  root.render(
    <SpeciesPopupLoading name={name} scientificName={scientificName} />,
  );
  return { container, root };
}

function updatePopupWithSpeciesInfo(
  container: HTMLDivElement,
  root: Root,
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
  root.render(
    <SpeciesPopup
      name={name}
      count={count}
      scientificName={info?.scientificName}
      info={info || undefined}
      observedAt={observedAt}
      isLifer={isLifer}
      isYearTick={isYearTick}
    />,
  );
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
  const { container, root } = createPopupContent(name, count, scientificName);

  let popup = new maplibregl.Popup({
    maxWidth: "none",
    subpixelPositioning: false,
  })
    .setLngLat([lng, lat])
    .setDOMContent(container)
    .addTo(map);

  fetchSpeciesInfo(name).then((info) => {
    if (popup.isOpen()) {
      // Don't update the existing popup's content in place — it results
      // in blurry text, presumably because MapLibre repositions the popup
      // with subpixel values when its size changes.
      root.unmount();
      popup.remove();
      // Wait for React to fully clean up the old root before creating new content.
      // This prevents interleaved rendering where old and new content appear mixed.
      // Use requestAnimationFrame to ensure cleanup completes before next render cycle.
      requestAnimationFrame(() => {
        const finalContainer = document.createElement("div");
        finalContainer.className = "species-popup";
        const finalRoot = createRoot(finalContainer);
        updatePopupWithSpeciesInfo(
          finalContainer,
          finalRoot,
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
          .setDOMContent(finalContainer)
          .addTo(map);
      });
    } else {
      root.unmount();
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

    // Use 1.5x supersampling for smoother 3D building edges on high-DPI displays
    const pixelRatio =
      typeof window !== "undefined" ? window.devicePixelRatio * 1.5 : 1;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [0, 20],
      zoom: 2,
      antialias: true,
      pixelRatio,
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

    // Increase scroll zoom speed (default 1/450 feels sluggish)
    map.scrollZoom.setZoomRate(1 / 225);

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
    if (!map || !map.getSource("sightings")) {
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
