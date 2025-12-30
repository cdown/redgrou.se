"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, Root } from "react-dom/client";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  apiFetch,
  buildApiUrl,
  buildFilterParams,
  getErrorMessage,
  parseProtoResponse,
  type ApiError,
} from "@/lib/api";
import { FilterGroup, filterToJson } from "@/lib/filter-types";
import { fetchSpeciesInfo } from "@/lib/species-api";
import { TILE_ROUTE, UPLOAD_BBOX_ROUTE } from "@/lib/generated/api_constants";
import { BboxResponse } from "@/lib/proto/redgrouse_api";
import { SpeciesPopup, SpeciesPopupLoading } from "@/components/species-popup";
import { useToast } from "@/components/ui/toast";
import { useMapInstance } from "@/components/map/use-map-instance";
import {
  TileSourceManager,
  type TileSourceParams,
} from "@/components/map/tile-source-manager";
import { ClusterController } from "@/components/map/cluster-controller";

interface SightingsMapProps {
  uploadId: string;
  filter: FilterGroup | null;
  tickFilterParam: string | null;
  yearTickYear: number | null;
  countryTickCountry: string | null;
  dataVersion: number;
  onMapReady?: (
    navigateToSighting: (sightingId: number, lat: number, lng: number) => void,
  ) => void;
  onRemoteVersionObserved?: (version: number) => void;
  onUploadDeleted?: () => void;
}

export function SightingsMap({
  uploadId,
  filter,
  tickFilterParam,
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
  const featuresByIdRef = useRef<Map<number, maplibregl.MapGeoJSONFeature>>(new Map());
  const tileManagerRef = useRef<TileSourceManager | null>(null);
  const clusterControllerRef = useRef<ClusterController | null>(null);
  const abortControllersRef = useRef(new Map<string, AbortController>());

  const transformRequest = useMemo(
    () => createTileTransform(abortControllersRef.current),
    [],
  );

  const [tileManagerReadyVersion, setTileManagerReadyVersion] = useState(0);

  const handleMapReady = useCallback(
    (map: maplibregl.Map) => {
      mapRef.current = map;
      featuresByIdRef.current.clear();
      tileManagerRef.current?.dispose();
      clusterControllerRef.current?.dispose();

      tileManagerRef.current = new TileSourceManager(map, {
        featuresById: featuresByIdRef.current,
        onFeatureClick: (feature) => handleSightingFeature(map, feature),
        isClickEnabled: () => !(clusterControllerRef.current?.isActive() ?? false),
      });
      setTileManagerReadyVersion((version) => version + 1);

      clusterControllerRef.current = new ClusterController({
        map,
        featuresById: featuresByIdRef.current,
        showPopupById: (sightingId, lat, lng) =>
          showPopupBySightingId(map, sightingId, lat, lng, featuresByIdRef.current),
        showToast,
      });

      if (onMapReady) {
        onMapReady((sightingId, lat, lng) => {
          showPopupBySightingId(map, sightingId, lat, lng, featuresByIdRef.current);
        });
      }
    },
    [onMapReady, showToast],
  );

  useMapInstance({
    containerRef,
    uploadId,
    onReady: handleMapReady,
    transformRequest,
  });

  useEffect(() => {
    const manager = tileManagerRef.current;
    if (!manager) {
      return;
    }
    const params: TileSourceParams = {
      uploadId,
      filter,
      tickFilterParam,
      yearTickYear,
      countryTickCountry,
      dataVersion,
    };
    manager.setParams(params);
  }, [
    uploadId,
    filter,
    tickFilterParam,
    yearTickYear,
    countryTickCountry,
    dataVersion,
    tileManagerReadyVersion,
  ]);

  useEffect(() => {
    const controllers = abortControllersRef.current;
    return () => {
      tileManagerRef.current?.dispose();
      clusterControllerRef.current?.dispose();
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !countryTickCountry) {
      return;
    }

    const params = buildFilterParams(
      filter ? filterToJson(filter) : null,
      tickFilterParam,
      yearTickYear,
      countryTickCountry,
    );
    const url = `${buildApiUrl(UPLOAD_BBOX_ROUTE, { upload_id: uploadId })}?${params}`;

    apiFetch(url)
      .then(async (res) => {
        if (res.status === 204) {
          return null;
        }
        if (!res.ok) {
          const { getApiErrorInfo } = await import("@/lib/api");
          const errorInfo = await getApiErrorInfo(res, "Failed to load map bounds");
          if (errorInfo.code === "MISSING_BITMAP") {
            return null;
          }
          if (res.status === 404 && errorInfo.message === "Upload not found") {
            onUploadDeleted?.();
            return null;
          }
          const error = new Error(errorInfo.message) as ApiError;
          if (errorInfo.code) {
            error.apiErrorCode = errorInfo.code;
          }
          throw error;
        }
        return parseProtoResponse(res, BboxResponse);
      })
      .then((bbox) => {
        if (!bbox || !map) {
          return;
        }
        onRemoteVersionObserved?.(bbox.dataVersion);
        map.fitBounds(
          [
            [bbox.minLng, bbox.minLat],
            [bbox.maxLng, bbox.maxLat],
          ],
          {
            padding: { top: 50, bottom: 50, left: 50, right: 50 },
            maxZoom: 12,
          },
        );
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
    filter,
    tickFilterParam,
    yearTickYear,
    countryTickCountry,
    showToast,
    onRemoteVersionObserved,
    onUploadDeleted,
  ]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function handleSightingFeature(
  map: maplibregl.Map,
  feature: maplibregl.MapGeoJSONFeature,
  overrideLocation?: { lat: number; lng: number },
) {
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
) {
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
) {
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
      root.unmount();
      popup.remove();
      requestAnimationFrame(() => {
        const finalContainer = document.createElement("div");
        finalContainer.className = "species-popup";
        const finalRoot = createRoot(finalContainer);
        finalRoot.render(
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

function createTileTransform(store: Map<string, AbortController>) {
  const fragment = TILE_ROUTE.replace("{upload_id}", "");
  return (url: string, resourceType?: maplibregl.ResourceType) => {
    if (resourceType === "Tile" && url.includes(fragment)) {
      const existing = store.get(url);
      if (existing) {
        existing.abort();
        store.delete(url);
      }
      const controller = new AbortController();
      store.set(url, controller);
      return { url, signal: controller.signal };
    }
    return { url };
  };
}
