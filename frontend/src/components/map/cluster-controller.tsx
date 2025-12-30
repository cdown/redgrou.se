import maplibregl from "maplibre-gl";
import type { Feature, Point, GeoJsonProperties } from "geojson";
import type { ExpressionSpecification } from "@maplibre/maplibre-gl-style-spec";
import { createRoot, Root } from "react-dom/client";
import { ClusterPopup, ClusterPopupSighting } from "@/components/cluster-popup";
import {
  COLOUR_COUNTRY_TICK,
  COLOUR_LIFER,
  COLOUR_NORMAL_SIGHTING,
  COLOUR_WHITE,
  COLOUR_YEAR_TICK,
} from "@/lib/colours";

type ClusterControllerOptions = {
  map: maplibregl.Map;
  featuresById: Map<number, maplibregl.MapGeoJSONFeature>;
  showPopupById: (sightingId: number, lat: number, lng: number) => void;
  showToast: (message: string, type?: "error" | "success" | "info") => void;
};

type OverlapFeatureProperties = {
  sightingId: number;
  name: string;
  scientificName?: string;
  count: number;
  observedAt?: string;
  isLifer: boolean;
  isYearTick: boolean;
  isCountryTick: boolean;
};

type OverlapFeature = Feature<Point, OverlapFeatureProperties>;

const CLUSTER_SOURCE_ID = "sightings-overlap";
const CLUSTER_LAYER_ID = "sightings-overlap-clusters";
const CLUSTER_COUNT_LAYER_ID = "sightings-overlap-cluster-count";
const CLUSTER_POINTS_LAYER_ID = "sightings-overlap-unclustered";
const CLUSTER_PIXEL_RADIUS = 1;
const TILE_HIT_LAYER_ID = "sightings-circles-hit";

type ClusterPropertyDefinition = [
  ExpressionSpecification | string,
  ExpressionSpecification,
];

const CLUSTER_PROPERTIES: Record<string, ClusterPropertyDefinition> = {
  hasLifer: booleanClusterProperty("isLifer"),
  hasYearTick: booleanClusterProperty("isYearTick"),
  hasCountryTick: booleanClusterProperty("isCountryTick"),
};

export class ClusterController {
  private clusterMode = false;
  private clusterPopup: maplibregl.Popup | null = null;
  private clusterPopupRoot: Root | null = null;
  private dataUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanups: Array<() => void> = [];
  private readonly maxZoom: number;
  private readonly activationZoom: number;

  constructor(private options: ClusterControllerOptions) {
    const configuredMaxZoom = options.map.getMaxZoom();
    this.maxZoom = Number.isFinite(configuredMaxZoom) ? configuredMaxZoom : 22;
    this.activationZoom = Math.max(this.maxZoom - 1, 0);
    this.initialise();
  }

  isActive() {
    return this.clusterMode;
  }

  dispose() {
    this.clusterMode = false;
    if (this.dataUpdateTimer) {
      clearTimeout(this.dataUpdateTimer);
      this.dataUpdateTimer = null;
    }
    this.clearClusterPopup();
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];

    const { map } = this.options;
    const canvas = map.getCanvas();
    if (!map.getStyle()) {
      if (canvas) {
        canvas.style.cursor = "";
      }
      return;
    }
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
    if (canvas) {
      canvas.style.cursor = "";
    }
  }

  private initialise() {
    if (!this.options.map.getSource(CLUSTER_SOURCE_ID)) {
      this.options.map.addSource(CLUSTER_SOURCE_ID, {
        type: "geojson",
        data: emptyFeatureCollection(),
        cluster: true,
        clusterRadius: CLUSTER_PIXEL_RADIUS,
        clusterMaxZoom: this.maxZoom,
        clusterProperties: CLUSTER_PROPERTIES,
      });
    }

    this.ensureLayers();
    this.registerEvents();
    this.updateMode();
  }

  private ensureLayers() {
    const { map } = this.options;
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
          "circle-sort-key": [
            "case",
            ["boolean", ["get", "isLifer"], false],
            3,
            ["boolean", ["get", "isYearTick"], false],
            2,
            ["boolean", ["get", "isCountryTick"], false],
            1,
            0,
          ],
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
  }

  private registerEvents() {
    const handleClusterClick = (event: maplibregl.MapLayerMouseEvent) => {
      if (!this.clusterMode || !event.features?.length) {
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
      const source = this.options.map.getSource(CLUSTER_SOURCE_ID) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (!source) {
        return;
      }

      if (this.options.map.getZoom() < this.maxZoom && source.getClusterExpansionZoom) {
        source
          .getClusterExpansionZoom(clusterId)
          .then((targetZoom) => {
            if (typeof targetZoom === "number") {
              this.options.map.easeTo({
                center: coordinates,
                zoom: Math.min(targetZoom, this.maxZoom),
              });
            }
          })
          .catch((err) => {
            console.error("Failed to get cluster expansion zoom:", err);
            this.options.showToast("Failed to zoom to cluster", "error");
          });
        return;
      }

      this.getClusterSightings(clusterId, pointCount)
        .then((sightings) => {
          if (sightings.length) {
            this.openClusterPopup(coordinates, sightings);
          }
        })
        .catch((err) => {
          console.error("Failed to get cluster sightings:", err);
          this.options.showToast("Failed to load cluster details", "error");
        });
    };

    const handleUnclusteredClick = (event: maplibregl.MapLayerMouseEvent) => {
      if (!this.clusterMode || !event.features?.length) {
        return;
      }
      const [feature] = [...event.features].sort(
        (a, b) => getFeaturePriority(b) - getFeaturePriority(a),
      );
      if (!feature || feature.geometry.type !== "Point") {
        return;
      }
      const coords = feature.geometry.coordinates as [number, number];
      const sightingId = getNumericId(feature.properties?.sightingId ?? feature.id);
      if (sightingId === null) {
        return;
      }
      this.options.showPopupById(sightingId, coords[1], coords[0]);
    };

    const handleZoom = () => {
      const shouldEnable = this.options.map.getZoom() >= this.activationZoom;
      if (this.clusterMode === shouldEnable) {
        if (shouldEnable) {
          this.scheduleClusterDataUpdate();
        }
        return;
      }
      this.clusterMode = shouldEnable;
      this.applyVisibility();
      if (shouldEnable) {
        this.updateClusterData();
      } else {
        this.clearClusterData();
      }
    };

    const handleMoveEnd = () => {
      if (this.clusterMode) {
        this.scheduleClusterDataUpdate();
      }
    };

    const handleSourceData = (event: maplibregl.MapSourceDataEvent) => {
      if (this.clusterMode && event.sourceId === "sightings" && event.isSourceLoaded) {
        this.scheduleClusterDataUpdate();
      }
    };

    const handleMouseEnter = () => {
      this.options.map.getCanvas().style.cursor = "pointer";
    };

    const handleMouseLeave = () => {
      this.options.map.getCanvas().style.cursor = "";
    };

    this.options.map.on("click", CLUSTER_LAYER_ID, handleClusterClick);
    this.options.map.on("click", CLUSTER_POINTS_LAYER_ID, handleUnclusteredClick);
    this.options.map.on("zoom", handleZoom);
    this.options.map.on("moveend", handleMoveEnd);
    this.options.map.on("sourcedata", handleSourceData);
    this.options.map.on("mouseenter", CLUSTER_LAYER_ID, handleMouseEnter);
    this.options.map.on("mouseleave", CLUSTER_LAYER_ID, handleMouseLeave);
    this.options.map.on("mouseenter", CLUSTER_POINTS_LAYER_ID, handleMouseEnter);
    this.options.map.on("mouseleave", CLUSTER_POINTS_LAYER_ID, handleMouseLeave);

    this.cleanups.push(
      () => this.options.map.off("click", CLUSTER_LAYER_ID, handleClusterClick),
      () => this.options.map.off("click", CLUSTER_POINTS_LAYER_ID, handleUnclusteredClick),
      () => this.options.map.off("zoom", handleZoom),
      () => this.options.map.off("moveend", handleMoveEnd),
      () => this.options.map.off("sourcedata", handleSourceData),
      () => this.options.map.off("mouseenter", CLUSTER_LAYER_ID, handleMouseEnter),
      () => this.options.map.off("mouseleave", CLUSTER_LAYER_ID, handleMouseLeave),
      () => this.options.map.off("mouseenter", CLUSTER_POINTS_LAYER_ID, handleMouseEnter),
      () => this.options.map.off("mouseleave", CLUSTER_POINTS_LAYER_ID, handleMouseLeave),
    );
  }

  private updateMode() {
    this.clusterMode = this.options.map.getZoom() >= this.activationZoom;
    this.applyVisibility();
    if (this.clusterMode) {
      this.updateClusterData();
    } else {
      this.clearClusterData();
    }
  }

  private applyVisibility() {
    const visibility = this.clusterMode ? "visible" : "none";
    if (this.options.map.getLayer("sightings-circles")) {
      this.options.map.setPaintProperty(
        "sightings-circles",
        "circle-opacity",
        this.clusterMode ? 0 : 1,
      );
      this.options.map.setPaintProperty(
        "sightings-circles",
        "circle-stroke-opacity",
        this.clusterMode ? 0 : 1,
      );
    }
    if (this.options.map.getLayer(CLUSTER_LAYER_ID)) {
      this.options.map.setLayoutProperty(CLUSTER_LAYER_ID, "visibility", visibility);
    }
    if (this.options.map.getLayer(CLUSTER_COUNT_LAYER_ID)) {
      this.options.map.setLayoutProperty(CLUSTER_COUNT_LAYER_ID, "visibility", visibility);
    }
    if (this.options.map.getLayer(CLUSTER_POINTS_LAYER_ID)) {
      this.options.map.setLayoutProperty(CLUSTER_POINTS_LAYER_ID, "visibility", visibility);
    }
    if (!this.clusterMode) {
      this.clearClusterPopup();
    }
  }

  private updateClusterData() {
    if (!this.clusterMode) {
      return;
    }
    const source = this.options.map.getSource(CLUSTER_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!source || !this.options.map.getLayer(TILE_HIT_LAYER_ID)) {
      return;
    }
    const rendered = this.options.map.queryRenderedFeatures(undefined, {
      layers: [TILE_HIT_LAYER_ID],
    });
    source.setData(buildOverlapFeatureCollection(rendered));
  }

  private clearClusterData() {
    const source = this.options.map.getSource(CLUSTER_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    source?.setData(emptyFeatureCollection());
  }

  private scheduleClusterDataUpdate() {
    if (!this.clusterMode || this.dataUpdateTimer) {
      return;
    }
    this.dataUpdateTimer = setTimeout(() => {
      this.dataUpdateTimer = null;
      this.updateClusterData();
    }, 120);
  }

  private clearClusterPopup() {
    if (this.clusterPopupRoot) {
      this.clusterPopupRoot.unmount();
      this.clusterPopupRoot = null;
    }
    if (this.clusterPopup) {
      this.clusterPopup.remove();
      this.clusterPopup = null;
    }
  }

  private openClusterPopup(
    coordinates: [number, number],
    sightings: ClusterPopupSighting[],
  ) {
    if (!sightings.length) {
      return;
    }
    this.clearClusterPopup();
    const container = document.createElement("div");
    container.className = "species-popup";
    this.clusterPopupRoot = createRoot(container);
    this.clusterPopupRoot.render(
      <ClusterPopup
        sightings={sightings}
        onSelect={(selected) => {
          this.clearClusterPopup();
          this.options.showPopupById(selected.id, coordinates[1], coordinates[0]);
        }}
      />,
    );
    this.clusterPopup = new maplibregl.Popup({
      maxWidth: "320px",
      closeButton: true,
      closeOnClick: true,
    })
      .setLngLat(coordinates)
      .setDOMContent(container)
      .addTo(this.options.map);
    this.clusterPopup.on("close", () => this.clearClusterPopup());
  }

  private async getClusterSightings(
    clusterId: number,
    total: number,
  ): Promise<ClusterPopupSighting[]> {
    const source = this.options.map.getSource(CLUSTER_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
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
          this.options.showToast("Failed to load cluster sightings", "error");
          return null;
        });
      if (!leaves?.length) {
        break;
      }

      const normalizedLeaves = leaves as Array<
        maplibregl.MapGeoJSONFeature | Feature<Point, GeoJsonProperties>
      >;

      normalizedLeaves.forEach((leaf) => {
        const sighting = mapLeafToSighting(leaf);
        if (sighting) {
          sightings.push(sighting);
        }
      });
      offset += normalizedLeaves.length;
    }

    return sightings;
  }
}

function booleanClusterProperty(property: string): ClusterPropertyDefinition {
  const mapExpression: ExpressionSpecification = [
    "case",
    ["boolean", ["get", property], false],
    1,
    0,
  ];
  return ["max", mapExpression];
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [],
  };
}

function buildOverlapFeatureCollection(
  features: maplibregl.MapGeoJSONFeature[],
): GeoJSON.FeatureCollection {
  const seen = new Set<number>();
  const converted: OverlapFeature[] = [];
  features.forEach((feature) => {
    const overlapFeature = convertToOverlapFeature(feature);
    if (!overlapFeature) {
      return;
    }
    if (seen.has(overlapFeature.properties.sightingId)) {
      return;
    }
    seen.add(overlapFeature.properties.sightingId);
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
  const sightingId = getNumericId(feature.id);
  if (sightingId === null) {
    return null;
  }
  const coords = feature.geometry.coordinates as [number, number];
  const props = feature.properties ?? {};
  return {
    type: "Feature",
    id: sightingId,
    geometry: {
      type: "Point",
      coordinates: coords,
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
  feature: maplibregl.MapGeoJSONFeature | Feature<Point>,
): ClusterPopupSighting | null {
  if (feature.geometry.type !== "Point" || !feature.geometry.coordinates) {
    return null;
  }
  const coordinates = feature.geometry.coordinates as [number, number];
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const sightingId = getNumericId(props.sightingId ?? feature.id);
  if (sightingId === null) {
    return null;
  }
  return {
    id: sightingId,
    lat: coordinates[1],
    lng: coordinates[0],
    name: typeof props.name === "string" ? (props.name as string) : "Unknown",
    scientificName:
      typeof props.scientificName === "string"
        ? (props.scientificName as string)
        : typeof props.scientific_name === "string"
        ? (props.scientific_name as string)
        : undefined,
    count: parseCount(props.count),
    observedAt:
      stringFromValue(props.observedAt) ?? stringFromValue(props.observed_at),
    isLifer: boolFromProperty(props.isLifer ?? props.lifer),
    isYearTick: boolFromProperty(props.isYearTick ?? props.year_tick),
    isCountryTick: boolFromProperty(props.isCountryTick ?? props.country_tick),
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

function getFeaturePriority(feature: maplibregl.MapGeoJSONFeature): number {
  const props = feature.properties;
  if (!props) {
    return 0;
  }
  const lifer = props.lifer ?? props.isLifer;
  const yearTick = props.year_tick ?? props.isYearTick;
  const countryTick = props.country_tick ?? props.isCountryTick;

  if (lifer === 1 || lifer === "1" || lifer === true) return 3;
  if (yearTick === 1 || yearTick === "1" || yearTick === true) return 2;
  if (countryTick === 1 || countryTick === "1" || countryTick === true) return 1;
  return 0;
}
