"use client";

import { useRef, useEffect, MutableRefObject } from "react";
import { createRoot, Root } from "react-dom/client";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection, GeoJsonProperties, Point } from "geojson";
import type { ExpressionSpecification } from "@maplibre/maplibre-gl-style-spec";
import {
  getApiUrl,
  buildApiUrl,
  apiFetch,
  buildFilterParams,
  parseProtoResponse,
  checkApiResponse,
  getErrorMessage,
} from "@/lib/api";
import { FilterGroup, filterToJson } from "@/lib/filter-types";
import { fetchSpeciesInfo } from "@/lib/species-api";
import { TILE_ROUTE, UPLOAD_BBOX_ROUTE } from "@/lib/generated/api_constants";
import { BboxResponse } from "@/lib/proto/redgrouse_api";
import { SpeciesPopup, SpeciesPopupLoading } from "@/components/species-popup";
import { ClusterPopup } from "@/components/cluster-popup";
import type { ClusterPopupSighting } from "@/components/cluster-popup";
import {
  COLOUR_LIFER,
  COLOUR_YEAR_TICK,
  COLOUR_COUNTRY_TICK,
  COLOUR_NORMAL_SIGHTING,
  COLOUR_WHITE,
} from "@/lib/colours";
import { useToast } from "@/components/ui/toast";

interface SightingsMapProps {
  uploadId: string;
  filter: FilterGroup | null;
  lifersOnly: boolean;
  yearTickYear: number | null;
  countryTickCountry: string | null;
  dataVersion: number;
  onMapReady?: (navigateToSighting: (sightingId: number, lat: number, lng: number) => void) => void;
  onRemoteVersionObserved?: (version: number) => void;
  onUploadDeleted?: () => void;
}

interface OverlapFeatureProperties {
  sightingId: number;
  name: string;
  scientificName?: string;
  count: number;
  observedAt?: string;
  isLifer: boolean;
  isYearTick: boolean;
  isCountryTick: boolean;
}

type OverlapFeature = Feature<Point, OverlapFeatureProperties>;

interface ClusterController {
  destroy: () => void;
  applyCurrentMode: () => void;
  clearData: () => void;
}

const CLUSTER_SOURCE_ID = "sightings-overlap";
const CLUSTER_LAYER_ID = "sightings-overlap-clusters";
const CLUSTER_COUNT_LAYER_ID = "sightings-overlap-cluster-count";
const CLUSTER_POINTS_LAYER_ID = "sightings-overlap-unclustered";
const CLUSTER_PIXEL_RADIUS = 1;

type ClusterPropertyDefinition = [ExpressionSpecification | string, ExpressionSpecification];

function booleanClusterProperty(property: string): ClusterPropertyDefinition {
  const mapExpression: ExpressionSpecification = [
    "case",
    ["boolean", ["get", property], false],
    1,
    0,
  ];
  return ["max", mapExpression];
}

const CLUSTER_AGGREGATE_PROPERTIES: Record<string, ClusterPropertyDefinition> = {
  hasLifer: booleanClusterProperty("isLifer"),
  hasYearTick: booleanClusterProperty("isYearTick"),
  hasCountryTick: booleanClusterProperty("isCountryTick"),
};

const TILE_SIGHTING_SORT_KEY: ExpressionSpecification = [
  "case",
  [">", ["get", "lifer"], 0],
  3,
  [">", ["get", "year_tick"], 0],
  2,
  [">", ["get", "country_tick"], 0],
  1,
  0,
];

const GEOJSON_SIGHTING_SORT_KEY: ExpressionSpecification = [
  "case",
  ["boolean", ["get", "isLifer"], false],
  3,
  ["boolean", ["get", "isYearTick"], false],
  2,
  ["boolean", ["get", "isCountryTick"], false],
  1,
  0,
];

function getFeaturePriority(feature: maplibregl.MapGeoJSONFeature): number {
  const props = feature.properties;
  if (!props) return 0;

  // Handle both tile features (lifer, year_tick, country_tick) and GeoJSON
  // features (isLifer, isYearTick, isCountryTick)
  const lifer = props.lifer ?? props.isLifer;
  const yearTick = props.year_tick ?? props.isYearTick;
  const countryTick = props.country_tick ?? props.isCountryTick;

  if (lifer === 1 || lifer === "1" || lifer === true) return 3;
  if (yearTick === 1 || yearTick === "1" || yearTick === true) return 2;
  if (countryTick === 1 || countryTick === "1" || countryTick === true) return 1;
  return 0;
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
  dataVersion: number,
): string {
  const params = buildFilterParams(
    filter ? filterToJson(filter) : null,
    lifersOnly,
    yearTickYear,
    countryTickCountry
  );
  params.set("data_version", String(dataVersion));
  params.set("data_version", String(dataVersion));
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
  overrideLocation?: { lat: number; lng: number },
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
  let lngFromFeature: number | undefined;
  let latFromFeature: number | undefined;
  if (geometry.type === "Point" && geometry.coordinates) {
    [lngFromFeature, latFromFeature] = geometry.coordinates;
  }

  const finalLat =
    typeof overrideLocation?.lat === "number" ? overrideLocation.lat : latFromFeature;
  const finalLng =
    typeof overrideLocation?.lng === "number" ? overrideLocation.lng : lngFromFeature;

  if (typeof finalLat !== "number" || typeof finalLng !== "number") {
    return;
  }

  showSpeciesPopup(
    map,
    finalLat,
    finalLng,
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
  if (!feature) {
    return;
  }
  const hasOverride = Number.isFinite(lat) && Number.isFinite(lng);
  const overrideLocation =
    hasOverride && typeof lat === "number" && typeof lng === "number"
      ? { lat, lng }
      : undefined;
  handleSightingFeature(map, feature, overrideLocation);
}

function addSightingsLayer(
  map: maplibregl.Map,
  featuresById: Map<number, maplibregl.MapGeoJSONFeature>,
  options?: { isClickEnabled?: () => boolean },
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
    layout: {
      "circle-sort-key": TILE_SIGHTING_SORT_KEY,
    },
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
    layout: {
      "circle-sort-key": TILE_SIGHTING_SORT_KEY,
    },
    paint: {
      "circle-radius": 6,
      "circle-color": [
        "case",
        [">", ["get", "lifer"], 0],
        COLOUR_LIFER,
        [">", ["get", "country_tick"], 0],
        COLOUR_COUNTRY_TICK,
        [">", ["get", "year_tick"], 0],
        COLOUR_YEAR_TICK,
        COLOUR_NORMAL_SIGHTING,
      ],
      "circle-stroke-width": 1.5,
      "circle-stroke-color": COLOUR_WHITE,
    },
  });

  map.on("click", "sightings-circles-hit", (e) => {
    if (options?.isClickEnabled && !options.isClickEnabled()) {
      return;
    }
    if (!e.features?.length) return;

    // Sort features by priority (highest first) to ensure we get the visually
    // topmost marker
    const sortedFeatures = [...e.features].sort((a, b) => {
      const priorityA = getFeaturePriority(a);
      const priorityB = getFeaturePriority(b);
      return priorityB - priorityA;
    });

    const feature = sortedFeatures[0];
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
  dataVersion,
  onMapReady,
  onRemoteVersionObserved,
  onUploadDeleted,
}: SightingsMapProps) {
  const { showToast } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const onMapReadyRef = useRef(onMapReady);
  const featuresByIdRef = useRef<Map<number, maplibregl.MapGeoJSONFeature>>(new Map());
  const clusterModeRef = useRef(false);
  const clusterControllerRef = useRef<ClusterController | null>(null);

  useEffect(() => {
    onMapReadyRef.current = onMapReady;
  }, [onMapReady]);

  useEffect(() => {
    if (!containerRef.current) return;

    if (mapRef.current) {
      clusterControllerRef.current?.destroy();
      clusterControllerRef.current = null;
      clusterModeRef.current = false;
      abortControllersRef.current.forEach((controller) => {
        controller.abort();
      });
      abortControllersRef.current.clear();
      mapRef.current.remove();
      mapRef.current = null;
    }

    clusterModeRef.current = false;

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
      const tileUrl = buildTileUrl(
        uploadId,
        filter,
        lifersOnly,
        yearTickYear,
        countryTickCountry,
        dataVersion,
      );

      map.addSource("sightings", {
        type: "vector",
        tiles: [tileUrl],
      });

      addSightingsLayer(map, featuresByIdRef.current, {
        isClickEnabled: () => !clusterModeRef.current,
      });

      clusterControllerRef.current?.destroy();
      clusterControllerRef.current = setupOverlapClusters(map, {
        clusterModeRef,
        showPopupById: (sightingId, lat, lng) => {
          showPopupBySightingId(map, sightingId, lat, lng, featuresByIdRef.current);
        },
        showToast,
      });

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
      clusterControllerRef.current?.destroy();
      clusterControllerRef.current = null;
      clusterModeRef.current = false;
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

    const tileUrl = buildTileUrl(
      uploadId,
      filter,
      lifersOnly,
      yearTickYear,
      countryTickCountry,
      dataVersion,
    );
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

    addSightingsLayer(map, featuresByIdRef.current, {
      isClickEnabled: () => !clusterModeRef.current,
    });

    clusterControllerRef.current?.clearData();
    clusterControllerRef.current?.applyCurrentMode();

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
  }, [uploadId, filter, lifersOnly, yearTickYear, countryTickCountry, dataVersion]);

useEffect(() => {
  const map = mapRef.current;
  if (!map || !countryTickCountry) {
    return;
  }

  const params = buildFilterParams(
    filter ? filterToJson(filter) : null,
    lifersOnly,
    yearTickYear,
    countryTickCountry
  );

  const url = `${buildApiUrl(UPLOAD_BBOX_ROUTE, { upload_id: uploadId })}?${params}`;

  apiFetch(url)
    .then(async (res) => {
      if (res.status === 404) {
        onUploadDeleted?.();
        return null;
      }
      await checkApiResponse(res, "Failed to load map bounds");
      return parseProtoResponse(res, BboxResponse);
    })
    .then((bbox) => {
      if (bbox && map) {
        onRemoteVersionObserved?.(bbox.dataVersion);
        map.fitBounds(
          [
            [bbox.minLng, bbox.minLat],
            [bbox.maxLng, bbox.maxLat],
          ],
          {
            padding: { top: 50, bottom: 50, left: 50, right: 50 },
            maxZoom: 12,
          }
        );
      }
    })
    .catch((err) => {
      console.error("Failed to fetch bounding box:", err);
      const message = getErrorMessage(err, "Failed to load map bounds");
      if (message === "Upload not found") {
        onUploadDeleted?.();
        return;
      }
      showToast(message, "error");
    });
}, [
  uploadId,
  countryTickCountry,
  filter,
  lifersOnly,
  yearTickYear,
  showToast,
  onRemoteVersionObserved,
  onUploadDeleted,
  dataVersion,
]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function setupOverlapClusters(
  map: maplibregl.Map,
  {
    clusterModeRef,
    showPopupById,
    showToast,
  }: {
    clusterModeRef: MutableRefObject<boolean>;
    showPopupById: (sightingId: number, lat: number, lng: number) => void;
    showToast: (message: string, type?: "error" | "success" | "info") => void;
  },
): ClusterController {
  const configuredMaxZoom = map.getMaxZoom();
  const maxZoom = Number.isFinite(configuredMaxZoom) ? configuredMaxZoom : 22;
  const activationZoom = Math.max(maxZoom - 1, 0);
  let clusterPopup: maplibregl.Popup | null = null;
  let clusterPopupRoot: Root | null = null;
  let dataUpdateTimer: ReturnType<typeof setTimeout> | null = null;

  if (!map.getSource(CLUSTER_SOURCE_ID)) {
    map.addSource(CLUSTER_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
      cluster: true,
      clusterRadius: CLUSTER_PIXEL_RADIUS,
      clusterMaxZoom: maxZoom,
      clusterProperties: CLUSTER_AGGREGATE_PROPERTIES,
    });
  }

  if (!map.getLayer(CLUSTER_LAYER_ID)) {
    map.addLayer({
      id: CLUSTER_LAYER_ID,
      type: "circle",
      source: CLUSTER_SOURCE_ID,
      layout: { visibility: "none" },
      filter: ["has", "point_count"],
      paint: {
        "circle-radius": ["step", ["get", "point_count"], 16, 5, 20, 15, 24],
        "circle-color": [
          "case",
          [">", ["get", "hasLifer"], 0],
          COLOUR_LIFER,
          [">", ["get", "hasYearTick"], 0],
          COLOUR_YEAR_TICK,
          [">", ["get", "hasCountryTick"], 0],
          COLOUR_COUNTRY_TICK,
          COLOUR_NORMAL_SIGHTING,
        ],
        "circle-opacity": 0.9,
        "circle-stroke-color": COLOUR_WHITE,
        "circle-stroke-width": 2,
      },
    });
  }

  if (!map.getLayer(CLUSTER_COUNT_LAYER_ID)) {
    map.addLayer({
      id: CLUSTER_COUNT_LAYER_ID,
      type: "symbol",
      source: CLUSTER_SOURCE_ID,
      layout: {
        visibility: "none",
        "text-field": ["to-string", ["get", "point_count"]],
        "text-size": 13,
      },
      filter: ["has", "point_count"],
      paint: {
        "text-color": COLOUR_WHITE,
      },
    });
  }

  if (!map.getLayer(CLUSTER_POINTS_LAYER_ID)) {
    map.addLayer({
      id: CLUSTER_POINTS_LAYER_ID,
      type: "circle",
      source: CLUSTER_SOURCE_ID,
      layout: {
        visibility: "none",
        "circle-sort-key": GEOJSON_SIGHTING_SORT_KEY,
      },
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": 6,
        "circle-color": [
          "case",
          ["boolean", ["get", "isLifer"], false],
          COLOUR_LIFER,
          ["boolean", ["get", "isCountryTick"], false],
          COLOUR_COUNTRY_TICK,
          ["boolean", ["get", "isYearTick"], false],
          COLOUR_YEAR_TICK,
          COLOUR_NORMAL_SIGHTING,
        ],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": COLOUR_WHITE,
      },
    });
  }

  const updateBaseLayerOpacity = (opacity: number) => {
    if (map.getLayer("sightings-circles")) {
      map.setPaintProperty("sightings-circles", "circle-opacity", opacity);
      map.setPaintProperty("sightings-circles", "circle-stroke-opacity", opacity);
    }
  };

  const setClusterVisibility = (visible: boolean) => {
    const visibility = visible ? "visible" : "none";
    if (map.getLayer(CLUSTER_LAYER_ID)) {
      map.setLayoutProperty(CLUSTER_LAYER_ID, "visibility", visibility);
    }
    if (map.getLayer(CLUSTER_COUNT_LAYER_ID)) {
      map.setLayoutProperty(CLUSTER_COUNT_LAYER_ID, "visibility", visibility);
    }
    if (map.getLayer(CLUSTER_POINTS_LAYER_ID)) {
      map.setLayoutProperty(CLUSTER_POINTS_LAYER_ID, "visibility", visibility);
    }
  };

  const clearClusterPopup = () => {
    if (clusterPopupRoot) {
      clusterPopupRoot.unmount();
      clusterPopupRoot = null;
    }
    if (clusterPopup) {
      clusterPopup.remove();
      clusterPopup = null;
    }
  };

  const applyCurrentMode = () => {
    const active = clusterModeRef.current;
    updateBaseLayerOpacity(active ? 0 : 1);
    setClusterVisibility(active);
    if (!active) {
      clearClusterPopup();
    }
  };

  const ensureClusterSource = () => map.getSource(CLUSTER_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;

  const clearClusterData = () => {
    const source = ensureClusterSource();
    if (source) {
      source.setData(emptyFeatureCollection());
    }
  };

  const updateClusterData = () => {
    if (!clusterModeRef.current) {
      return;
    }
    const source = ensureClusterSource();
    if (!source || !map.getLayer("sightings-circles-hit")) {
      return;
    }
    const rendered = map.queryRenderedFeatures(undefined, {
      layers: ["sightings-circles-hit"],
    });
    source.setData(buildOverlapFeatureCollection(rendered));
  };

  const scheduleClusterDataUpdate = () => {
    if (!clusterModeRef.current) {
      return;
    }
    if (dataUpdateTimer) {
      return;
    }
    dataUpdateTimer = setTimeout(() => {
      dataUpdateTimer = null;
      updateClusterData();
    }, 120);
  };

  const openClusterPopup = (
    coordinates: [number, number],
    sightings: ClusterPopupSighting[],
  ) => {
    if (!sightings.length) {
      return;
    }
    clearClusterPopup();
    const container = document.createElement("div");
    container.className = "species-popup";
    clusterPopupRoot = createRoot(container);
    clusterPopupRoot.render(
      <ClusterPopup
        sightings={sightings}
        onSelect={(selected) => {
          clearClusterPopup();
          showPopupById(selected.id, coordinates[1], coordinates[0]);
        }}
      />,
    );
    clusterPopup = new maplibregl.Popup({
      maxWidth: "320px",
      closeButton: true,
      closeOnClick: true,
    })
      .setLngLat(coordinates)
      .setDOMContent(container)
      .addTo(map);
    clusterPopup.on("close", () => {
      clearClusterPopup();
    });
  };

  const getClusterSightings = async (
    clusterId: number,
    total: number,
  ): Promise<ClusterPopupSighting[]> => {
    const source = ensureClusterSource();
    if (!source || !source.getClusterLeaves) {
      return [];
    }
    const sightings: ClusterPopupSighting[] = [];
    const pageSize = 25;
    let offset = 0;

    while (sightings.length < total) {
      const leaves = await source
        .getClusterLeaves(clusterId, pageSize, offset)
        .catch((err) => {
          console.error("Failed to get cluster leaves:", err);
          showToast("Failed to load cluster sightings", "error");
          return null;
        });
      const normalizedLeaves = leaves as
        | Array<maplibregl.MapGeoJSONFeature | Feature<Point, GeoJsonProperties>>
        | null;

      if (!normalizedLeaves || !normalizedLeaves.length) {
        break;
      }

      normalizedLeaves.forEach((leaf) => {
        const sighting = mapLeafToSighting(leaf);
        if (sighting) {
          sightings.push(sighting);
        }
      });
      offset += normalizedLeaves.length;
    }

    return sightings;
  };

  const handleClusterClick = (event: maplibregl.MapLayerMouseEvent) => {
    if (!clusterModeRef.current || !event.features?.length) {
      return;
    }
    const feature = event.features[0];
    if (feature.geometry.type !== "Point" || !feature.geometry.coordinates) {
      return;
    }
    const coordinates = feature.geometry.coordinates as [number, number];
    const clusterId = getNumericId(
      feature.properties?.cluster_id ?? feature.properties?.clusterId,
    );
    if (clusterId === null) {
      return;
    }
    const pointCount = parseCount(feature.properties?.point_count);
    const currentZoom = map.getZoom();
    const source = ensureClusterSource();
    if (!source) {
      return;
    }

    if (currentZoom < maxZoom && source.getClusterExpansionZoom) {
      source
        .getClusterExpansionZoom(clusterId)
        .then((targetZoom) => {
          if (typeof targetZoom !== "number") {
            return;
          }
          map.easeTo({
            center: coordinates,
            zoom: Math.min(targetZoom, maxZoom),
          });
        })
        .catch((err) => {
          console.error("Failed to get cluster expansion zoom:", err);
          showToast("Failed to zoom to cluster", "error");
        });
      return;
    }

    getClusterSightings(clusterId, pointCount)
      .then((sightings) => {
        if (sightings.length) {
          openClusterPopup(coordinates, sightings);
        }
      })
      .catch((err) => {
        console.error("Failed to get cluster sightings:", err);
        showToast("Failed to load cluster details", "error");
      });
  };

  const handleUnclusteredClick = (event: maplibregl.MapLayerMouseEvent) => {
    if (!clusterModeRef.current || !event.features?.length) {
      return;
    }

    // Sort features by priority (highest first) to ensure we get the visually
    // topmost marker
    const sortedFeatures = [...event.features].sort((a, b) => {
      const priorityA = getFeaturePriority(a);
      const priorityB = getFeaturePriority(b);
      return priorityB - priorityA;
    });

    const feature = sortedFeatures[0];
    if (feature.geometry.type !== "Point" || !feature.geometry.coordinates) {
      return;
    }
    const coordinates = feature.geometry.coordinates as [number, number];
    const sightingId = getNumericId(feature.properties?.sightingId ?? feature.id);
    if (sightingId === null) {
      return;
    }
    showPopupById(sightingId, coordinates[1], coordinates[0]);
  };

  const handleZoomChange = () => {
    const shouldEnable = map.getZoom() >= activationZoom;
    if (clusterModeRef.current === shouldEnable) {
      if (shouldEnable) {
        scheduleClusterDataUpdate();
      }
      return;
    }
    clusterModeRef.current = shouldEnable;
    applyCurrentMode();
    if (shouldEnable) {
      updateClusterData();
    } else {
      clearClusterData();
    }
  };

  const handleMoveEnd = () => {
    if (clusterModeRef.current) {
      scheduleClusterDataUpdate();
    }
  };

  const handleSourceData = (event: maplibregl.MapSourceDataEvent) => {
    if (clusterModeRef.current && event.sourceId === "sightings" && event.isSourceLoaded) {
      scheduleClusterDataUpdate();
    }
  };

  const handleMouseEnter = () => {
    map.getCanvas().style.cursor = "pointer";
  };

  const handleMouseLeave = () => {
    map.getCanvas().style.cursor = "";
  };

  map.on("zoom", handleZoomChange);
  map.on("moveend", handleMoveEnd);
  map.on("sourcedata", handleSourceData);
  map.on("click", CLUSTER_LAYER_ID, handleClusterClick);
  map.on("click", CLUSTER_POINTS_LAYER_ID, handleUnclusteredClick);
  map.on("mouseenter", CLUSTER_LAYER_ID, handleMouseEnter);
  map.on("mouseleave", CLUSTER_LAYER_ID, handleMouseLeave);
  map.on("mouseenter", CLUSTER_POINTS_LAYER_ID, handleMouseEnter);
  map.on("mouseleave", CLUSTER_POINTS_LAYER_ID, handleMouseLeave);

  handleZoomChange();

  return {
    destroy: () => {
      clusterModeRef.current = false;
      if (dataUpdateTimer) {
        clearTimeout(dataUpdateTimer);
        dataUpdateTimer = null;
      }
      clearClusterPopup();
      map.off("zoom", handleZoomChange);
      map.off("moveend", handleMoveEnd);
      map.off("sourcedata", handleSourceData);
      map.off("click", CLUSTER_LAYER_ID, handleClusterClick);
      map.off("click", CLUSTER_POINTS_LAYER_ID, handleUnclusteredClick);
      map.off("mouseenter", CLUSTER_LAYER_ID, handleMouseEnter);
      map.off("mouseleave", CLUSTER_LAYER_ID, handleMouseLeave);
      map.off("mouseenter", CLUSTER_POINTS_LAYER_ID, handleMouseEnter);
      map.off("mouseleave", CLUSTER_POINTS_LAYER_ID, handleMouseLeave);
      if (map.getLayer(CLUSTER_POINTS_LAYER_ID)) {
        map.removeLayer(CLUSTER_POINTS_LAYER_ID);
      }
      if (map.getLayer(CLUSTER_COUNT_LAYER_ID)) {
        map.removeLayer(CLUSTER_COUNT_LAYER_ID);
      }
      if (map.getLayer(CLUSTER_LAYER_ID)) {
        map.removeLayer(CLUSTER_LAYER_ID);
      }
      if (map.getSource(CLUSTER_SOURCE_ID)) {
        map.removeSource(CLUSTER_SOURCE_ID);
      }
      updateBaseLayerOpacity(1);
      map.getCanvas().style.cursor = "";
    },
    applyCurrentMode,
    clearData: clearClusterData,
  };
}

function emptyFeatureCollection(): FeatureCollection<Point, OverlapFeatureProperties> {
  return {
    type: "FeatureCollection",
    features: [],
  };
}

function buildOverlapFeatureCollection(
  features: maplibregl.MapGeoJSONFeature[],
): FeatureCollection<Point, OverlapFeatureProperties> {
  const seen = new Set<number>();
  const converted: OverlapFeature[] = [];
  features.forEach((feature) => {
    const overlapFeature = convertToOverlapFeature(feature);
    if (!overlapFeature) {
      return;
    }
    const sightingId = overlapFeature.properties.sightingId;
    if (seen.has(sightingId)) {
      return;
    }
    seen.add(sightingId);
    converted.push(overlapFeature);
  });

  return {
    type: "FeatureCollection",
    features: converted,
  };
}

function convertToOverlapFeature(feature: maplibregl.MapGeoJSONFeature): OverlapFeature | null {
  if (feature.geometry.type !== "Point" || !feature.geometry.coordinates) {
    return null;
  }
  const coordinates = feature.geometry.coordinates as [number, number];
  const sightingId = getNumericId(feature.id);
  if (sightingId === null) {
    return null;
  }
  const props = feature.properties ?? {};

  return {
    type: "Feature",
    id: sightingId,
    geometry: {
      type: "Point",
      coordinates,
    },
    properties: {
      sightingId,
      name: typeof props.name === "string" ? props.name : "Unknown",
      scientificName:
        typeof props.scientific_name === "string" ? props.scientific_name : undefined,
      count: parseCount(props.count),
      observedAt: props.observed_at?.toString(),
      isLifer: boolFromProperty(props.lifer),
      isYearTick: boolFromProperty(props.year_tick),
      isCountryTick: boolFromProperty(props.country_tick),
    },
  };
}

function mapLeafToSighting(
  feature: maplibregl.MapGeoJSONFeature | Feature<Point, GeoJsonProperties>,
): ClusterPopupSighting | null {
  if (feature.geometry.type !== "Point" || !feature.geometry.coordinates) {
    return null;
  }
  const coordinates = feature.geometry.coordinates as [number, number];
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const baseId = "id" in feature ? feature.id : undefined;
  const sightingId = getNumericId(properties.sightingId ?? baseId);
  if (sightingId === null) {
    return null;
  }

  return {
    id: sightingId,
    lat: coordinates[1],
    lng: coordinates[0],
    name: typeof properties.name === "string" ? (properties.name as string) : "Unknown",
    scientificName:
      typeof properties.scientificName === "string"
        ? (properties.scientificName as string)
        : typeof properties.scientific_name === "string"
        ? (properties.scientific_name as string)
        : undefined,
    count: parseCount(properties.count),
    observedAt:
      stringFromValue(properties.observedAt) ?? stringFromValue(properties.observed_at),
    isLifer: boolFromProperty(properties.isLifer ?? properties.lifer),
    isYearTick: boolFromProperty(properties.isYearTick ?? properties.year_tick),
    isCountryTick: boolFromProperty(properties.isCountryTick ?? properties.country_tick),
  };
}

function getNumericId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function parseCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 1;
}

function boolFromProperty(value: unknown): boolean {
  return value === 1 || value === "1" || value === true;
}

function stringFromValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return String(value);
}
