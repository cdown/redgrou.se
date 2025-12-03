"use client";

import { useRef, useEffect } from "react";
import { createRoot, Root } from "react-dom/client";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { getApiUrl, buildApiUrl, apiFetch } from "@/lib/api";
import { FilterGroup, filterToJson } from "@/lib/filter-types";
import { fetchSpeciesInfo } from "@/lib/species-api";
import { TILE_ROUTE, UPLOAD_BBOX_ROUTE } from "@/lib/generated/api_constants";
import { SpeciesPopup, SpeciesPopupLoading } from "@/components/species-popup";

interface SightingsMapProps {
  uploadId: string;
  filter: FilterGroup | null;
  lifersOnly: boolean;
  yearTickYear: number | null;
  countryTickCountry: string | null;
  onMapReady?: (navigateToSighting: (sightingId: number, lat: number, lng: number) => void) => void;
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
  isCountryTick?: boolean,
): void {
  root.render(
    <SpeciesPopup
      name={name}
      count={count}
      info={info || undefined}
      observedAt={observedAt}
      isLifer={isLifer}
      isYearTick={isYearTick}
      isCountryTick={isCountryTick}
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
  isCountryTick?: boolean,
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
          isCountryTick,
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
  countryTickCountry: string | null,
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
  if (countryTickCountry !== null) {
    params.set("country_tick_country", countryTickCountry);
  }

  const queryString = params.toString();
  const filterParam = queryString ? `?${queryString}` : "";

  return getApiUrl(
    buildApiUrl(TILE_ROUTE, { upload_id: uploadId }) + ".pbf" + filterParam,
  );
}

/**
 * Process a feature and show the popup - shared logic for both click and navigation
 */
function handleSightingFeature(
  map: maplibregl.Map,
  feature: maplibregl.MapGeoJSONFeature,
): void {
  const name = feature.properties?.name || "Unknown";
  const scientificName = feature.properties?.scientific_name;
  const count =
    typeof feature.properties?.count === "number"
      ? feature.properties.count
      : parseInt(feature.properties?.count?.toString() || "1", 10);
  const observedAt = feature.properties?.observed_at?.toString();
  const lifer = feature.properties?.lifer;
  const yearTick = feature.properties?.year_tick;
  const countryTick = feature.properties?.country_tick;
  const isLifer = lifer === 1 || lifer === "1" || lifer === true;
  const isYearTick = yearTick === 1 || yearTick === "1" || yearTick === true;
  const isCountryTick = countryTick === 1 || countryTick === "1" || countryTick === true;

  // Use feature's geometry coordinates (center of icon) instead of click position
  const geometry = feature.geometry;
  if (geometry.type !== "Point" || !geometry.coordinates) {
    return;
  }
  const [lng, lat] = geometry.coordinates;

  showSpeciesPopup(
    map,
    lat,
    lng,
    name,
    count,
    scientificName,
    observedAt,
    isLifer,
    isYearTick,
    isCountryTick,
  );
}

function showPopupBySightingId(
  map: maplibregl.Map,
  sightingId: number,
  lat: number,
  lng: number,
  featuresById: Map<number, maplibregl.MapGeoJSONFeature>,
): void {
  const feature = featuresById.get(sightingId);

  if (feature) {
    handleSightingFeature(map, feature);
  }
}

function addSightingsLayer(
  map: maplibregl.Map,
  featuresById: Map<number, maplibregl.MapGeoJSONFeature>,
): void {
  if (map.getLayer("sightings-circles")) {
    return;
  }

  // Add invisible hit detection layer with larger radius for better tap targets
  map.addLayer({
    id: "sightings-circles-hit",
    type: "circle",
    source: "sightings",
    "source-layer": "sightings",
    paint: {
      "circle-radius": 12,
      "circle-opacity": 0,
    },
  });

  // Add visible layer with original small radius
  map.addLayer({
    id: "sightings-circles",
    type: "circle",
    source: "sightings",
    "source-layer": "sightings",
    paint: {
      "circle-radius": 6,
      "circle-color": [
        "case",
        [">", ["get", "lifer"], 0],
        "#9333EA", // Purple for lifers
        [">", ["get", "country_tick"], 0],
        "#F97316", // Gold/Orange for country ticks
        [">", ["get", "year_tick"], 0],
        "#3B82F6", // Blue for year ticks
        "#e63946", // Red for normal sightings
      ],
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#fff",
    },
  });

  map.on("click", "sightings-circles-hit", (e) => {
    if (!e.features?.length) return;
    const feature = e.features[0];
    const featureId = feature.id;
    if (typeof featureId !== "number") return;

    featuresById.set(featureId, feature);

    const geometry = feature.geometry;
    if (geometry.type !== "Point" || !geometry.coordinates) {
      return;
    }
    const [lng, lat] = geometry.coordinates;

    showPopupBySightingId(map, featureId, lat, lng, featuresById);
  });

  map.on("mouseenter", "sightings-circles-hit", () => {
    map.getCanvas().style.cursor = "pointer";
  });

  map.on("mouseleave", "sightings-circles-hit", () => {
    map.getCanvas().style.cursor = "";
  });
}

export function SightingsMap({
  uploadId,
  filter,
  lifersOnly,
  yearTickYear,
  countryTickCountry,
  onMapReady,
}: SightingsMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const onMapReadyRef = useRef(onMapReady);
  const featuresByIdRef = useRef<Map<number, maplibregl.MapGeoJSONFeature>>(new Map());

  useEffect(() => {
    onMapReadyRef.current = onMapReady;
  }, [onMapReady]);

  useEffect(() => {
    if (!containerRef.current) return;

    if (mapRef.current) {
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
        return undefined;
      },
    });

    // Use MutationObserver to ensure attribution starts collapsed
    const container = map.getContainer();
    const attributionObserver = new MutationObserver(() => {
      const attribElement = container.querySelector(".maplibregl-ctrl-attrib") as HTMLElement;
      if (attribElement) {
        if (!attribElement.classList.contains("maplibregl-compact")) {
          attribElement.classList.add("maplibregl-compact");
        }
        if (attribElement.classList.contains("maplibregl-compact-show")) {
          attribElement.classList.remove("maplibregl-compact-show");
        }
        // Let MapLibre handle it from here
        attributionObserver.disconnect();
      }
    });
    attributionObserver.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });

    // Try to collapse immediately
    requestAnimationFrame(() => {
      const attribElement = container.querySelector(".maplibregl-ctrl-attrib") as HTMLElement;
      if (attribElement) {
        attribElement.classList.add("maplibregl-compact");
        if (attribElement.classList.contains("maplibregl-compact-show")) {
          attribElement.classList.remove("maplibregl-compact-show");
        }
        attributionObserver.disconnect();
      }
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

    const createNavigateFunction = () => {
      return (sightingId: number, lat: number, lng: number) => {
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

        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          console.warn("Coordinates out of valid range:", { lat, lng });
          return;
        }

        if (typeof sightingId !== "number" || isNaN(sightingId) || !isFinite(sightingId)) {
          console.warn("Invalid sighting ID for navigation:", { sightingId });
          return;
        }

        // After map moves, find feature by ID and show popup
        const showPopupById = () => {
          // Small delay to ensure tiles are loaded, idle is too slow
          setTimeout(() => {
            showPopupBySightingId(map, sightingId, lat, lng, featuresByIdRef.current);
          }, 200);
        };

        const handleMoveEnd = () => {
          map.off("moveend", handleMoveEnd);
          showPopupById();
        };
        map.once("moveend", handleMoveEnd);

        map.flyTo({
          center: [lng, lat],
          zoom: 15,
          duration: 1000,
        });
      };
    };

    map.on("load", () => {
      const tileUrl = buildTileUrl(uploadId, filter, lifersOnly, yearTickYear, countryTickCountry);

      map.addSource("sightings", {
        type: "vector",
        tiles: [tileUrl],
      });

      addSightingsLayer(map, featuresByIdRef.current);

      // Pre-cache all features as tiles load for O(1) lookup
      // Must be after layers are added so the layer exists when querying
      const source = map.getSource("sightings") as maplibregl.VectorTileSource;
      if (source) {
        const cacheFeatures = () => {
          if (!map.getLayer("sightings-circles-hit")) {
            return;
          }
          const features = map.queryRenderedFeatures(undefined, {
            layers: ["sightings-circles-hit"],
          });
          features.forEach((feature) => {
            if (typeof feature.id === "number") {
              featuresByIdRef.current.set(feature.id, feature);
            }
          });
        };

        source.on("data", (e) => {
          if (e.dataType === "source" && e.isSourceLoaded) {
            cacheFeatures();
          }
        });

        map.on("sourcedata", (e) => {
          if (e.sourceId === "sightings" && e.isSourceLoaded) {
            cacheFeatures();
          }
        });
      }

      if (onMapReadyRef.current) {
        onMapReadyRef.current(createNavigateFunction());
      }
    });

    mapRef.current = map;

    return () => {
      attributionObserver.disconnect();
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

  // Update tile source when filters change, preserving the viewport
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource("sightings")) {
      return;
    }

    const tileUrl = buildTileUrl(uploadId, filter, lifersOnly, yearTickYear, countryTickCountry);
    const source = map.getSource("sightings") as maplibregl.VectorTileSource;

    if (source && source.tiles && source.tiles[0] === tileUrl) {
      return;
    }

    const center = map.getCenter();
    const zoom = map.getZoom();
    const bearing = map.getBearing();
    const pitch = map.getPitch();

    featuresByIdRef.current.clear();

    // Remove dependent layers before swapping the source
    if (map.getLayer("sightings-circles-hit")) {
      map.removeLayer("sightings-circles-hit");
    }
    if (map.getLayer("sightings-circles")) {
      map.removeLayer("sightings-circles");
    }

    map.removeSource("sightings");
    map.addSource("sightings", {
      type: "vector",
      tiles: [tileUrl],
    });

    addSightingsLayer(map, featuresByIdRef.current);

    const newSource = map.getSource("sightings") as maplibregl.VectorTileSource;
    if (newSource) {
      const cacheFeatures = () => {
        if (!map.getLayer("sightings-circles-hit")) {
          return;
        }
        const features = map.queryRenderedFeatures(undefined, {
          layers: ["sightings-circles-hit"],
        });
        features.forEach((feature) => {
          if (typeof feature.id === "number") {
            featuresByIdRef.current.set(feature.id, feature);
          }
        });
      };

      newSource.on("data", (e) => {
        if (e.dataType === "source" && e.isSourceLoaded) {
          cacheFeatures();
        }
      });

      map.on("sourcedata", (e) => {
        if (e.sourceId === "sightings" && e.isSourceLoaded) {
          cacheFeatures();
        }
      });
    }

    map.jumpTo({
      center: center,
      zoom: zoom,
      bearing: bearing,
      pitch: pitch,
    });
  }, [uploadId, filter, lifersOnly, yearTickYear, countryTickCountry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !countryTickCountry) {
      return;
    }

    const params = new URLSearchParams();
    params.set("country_tick_country", countryTickCountry);
    if (filter) {
      params.set("filter", filterToJson(filter));
    }
    if (lifersOnly) {
      params.set("lifers_only", "true");
    }
    if (yearTickYear !== null) {
      params.set("year_tick_year", String(yearTickYear));
    }

    const url = `${buildApiUrl(UPLOAD_BBOX_ROUTE, { upload_id: uploadId })}?${params}`;

    apiFetch(url)
      .then((res) => {
        if (!res.ok) {
          return null;
        }
        return res.json();
      })
      .then((bbox: { min_lng: number; min_lat: number; max_lng: number; max_lat: number } | null) => {
        if (bbox && map) {
          map.fitBounds(
            [
              [bbox.min_lng, bbox.min_lat],
              [bbox.max_lng, bbox.max_lat],
            ],
            {
              padding: { top: 50, bottom: 50, left: 50, right: 50 },
              maxZoom: 12,
            }
          );
        }
      })
      .catch(() => {});
  }, [uploadId, countryTickCountry, filter, lifersOnly, yearTickYear]);

  return <div ref={containerRef} className="h-full w-full" />;
}
