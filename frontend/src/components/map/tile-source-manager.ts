import maplibregl from "maplibre-gl";
import { buildApiUrl, getApiUrl, buildFilterParams } from "@/lib/api";
import { FilterGroup, filterToJson } from "@/lib/filter-types";
import {
  COLOUR_COUNTRY_TICK,
  COLOUR_LIFER,
  COLOUR_NORMAL_SIGHTING,
  COLOUR_WHITE,
  COLOUR_YEAR_TICK,
} from "@/lib/colours";
import { TILE_ROUTE } from "@/lib/generated/api_constants";

type FeatureClickHandler = (feature: maplibregl.MapGeoJSONFeature) => void;

export type TileSourceParams = {
  uploadId: string;
  filter: FilterGroup | null;
  tickFilterParam: string | null;
  yearTickYear: number | null;
  countryTickCountry: string | null;
  dataVersion: number;
};

type TileSourceManagerOptions = {
  featuresById: Map<number, maplibregl.MapGeoJSONFeature>;
  onFeatureClick: FeatureClickHandler;
  isClickEnabled: () => boolean;
};

const SOURCE_ID = "sightings";
const HIT_LAYER_ID = "sightings-circles-hit";
const VISIBLE_LAYER_ID = "sightings-circles";

export class TileSourceManager {
  private currentUrl: string | null = null;
  private disposeFns: Array<() => void> = [];

  constructor(
    private map: maplibregl.Map,
    private options: TileSourceManagerOptions,
  ) {}

  setParams(params: TileSourceParams) {
    if (!this.map.getStyle()) {
      return;
    }
    const tileUrl = buildTileUrl(params);
    if (!this.map.getSource(SOURCE_ID)) {
      this.initialiseSource(tileUrl);
      return;
    }

    if (this.currentUrl === tileUrl) {
      return;
    }

    this.recreateSource(tileUrl);
  }

  dispose() {
    this.disposeFns.forEach((fn) => fn());
    this.disposeFns = [];

    if (!this.map?.getStyle()) {
      return;
    }
    if (this.map.getLayer(HIT_LAYER_ID)) {
      this.map.removeLayer(HIT_LAYER_ID);
    }
    if (this.map.getLayer(VISIBLE_LAYER_ID)) {
      this.map.removeLayer(VISIBLE_LAYER_ID);
    }
    if (this.map.getSource(SOURCE_ID)) {
      this.map.removeSource(SOURCE_ID);
    }
  }

  private initialiseSource(tileUrl: string) {
    this.map.addSource(SOURCE_ID, {
      type: "vector",
      tiles: [tileUrl],
    });
    this.currentUrl = tileUrl;
    this.addLayers();
    this.registerSourceListeners();
  }

  private recreateSource(tileUrl: string) {
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    const bearing = this.map.getBearing();
    const pitch = this.map.getPitch();

    if (this.map.getLayer(HIT_LAYER_ID)) {
      this.map.removeLayer(HIT_LAYER_ID);
    }
    if (this.map.getLayer(VISIBLE_LAYER_ID)) {
      this.map.removeLayer(VISIBLE_LAYER_ID);
    }
    if (this.map.getSource(SOURCE_ID)) {
      this.map.removeSource(SOURCE_ID);
    }

    this.map.addSource(SOURCE_ID, {
      type: "vector",
      tiles: [tileUrl],
    });
    this.currentUrl = tileUrl;
    this.addLayers();
    this.registerSourceListeners();

    this.map.jumpTo({
      center,
      zoom,
      bearing,
      pitch,
    });
  }

  private addLayers() {
    if (this.map.getLayer(HIT_LAYER_ID) || this.map.getLayer(VISIBLE_LAYER_ID)) {
      return;
    }

    this.map.addLayer({
      id: HIT_LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      "source-layer": SOURCE_ID,
      layout: {
        "circle-sort-key": [
          "case",
          [">", ["get", "lifer"], 0],
          3,
          [">", ["get", "year_tick"], 0],
          2,
          [">", ["get", "country_tick"], 0],
          1,
          0,
        ],
      },
      paint: {
        "circle-radius": 12,
        "circle-opacity": 0,
      },
    });

    this.map.addLayer({
      id: VISIBLE_LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      "source-layer": SOURCE_ID,
      layout: {
        "circle-sort-key": [
          "case",
          [">", ["get", "lifer"], 0],
          3,
          [">", ["get", "country_tick"], 0],
          2,
          [">", ["get", "year_tick"], 0],
          1,
          0,
        ],
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

    const handleClick = (event: maplibregl.MapLayerMouseEvent) => {
      if (!this.options.isClickEnabled() || !event.features?.length) {
        return;
      }
      const [feature] = [...event.features]
        .filter((f) => typeof f.id === "number")
        .sort((a, b) => getFeaturePriority(b) - getFeaturePriority(a));
      if (feature && typeof feature.id === "number") {
        this.options.featuresById.set(feature.id, feature);
        this.options.onFeatureClick(feature);
      }
    };

    const handleMouseEnter = () => {
      this.map.getCanvas().style.cursor = "pointer";
    };

    const handleMouseLeave = () => {
      this.map.getCanvas().style.cursor = "";
    };

    this.map.on("click", HIT_LAYER_ID, handleClick);
    this.map.on("mouseenter", HIT_LAYER_ID, handleMouseEnter);
    this.map.on("mouseleave", HIT_LAYER_ID, handleMouseLeave);

    this.disposeFns.push(
      () => this.map.off("click", HIT_LAYER_ID, handleClick),
      () => this.map.off("mouseenter", HIT_LAYER_ID, handleMouseEnter),
      () => this.map.off("mouseleave", HIT_LAYER_ID, handleMouseLeave),
    );
  }

  private registerSourceListeners() {
    const cacheFeatures = () => {
      if (!this.map.getLayer(HIT_LAYER_ID)) {
        return;
      }
      const features = this.map.queryRenderedFeatures(undefined, {
        layers: [HIT_LAYER_ID],
      });
      features.forEach((feature) => {
        if (typeof feature.id === "number") {
          this.options.featuresById.set(feature.id, feature);
        }
      });
    };

    const handleSourceData = (event: maplibregl.MapSourceDataEvent) => {
      if (event.sourceId === SOURCE_ID && event.isSourceLoaded) {
        cacheFeatures();
      }
    };

    this.map.on("sourcedata", handleSourceData);
    this.disposeFns.push(() => this.map.off("sourcedata", handleSourceData));

    const source = this.map.getSource(SOURCE_ID) as maplibregl.VectorTileSource | undefined;
    if (source) {
      const handleData = (event: { dataType?: string; isSourceLoaded?: boolean }) => {
        if (event.dataType === "source" && event.isSourceLoaded) {
          cacheFeatures();
        }
      };
      source.on("data", handleData);
      this.disposeFns.push(() => source.off("data", handleData));
    }
  }
}

function buildTileUrl({
  uploadId,
  filter,
  tickFilterParam,
  yearTickYear,
  countryTickCountry,
  dataVersion,
}: TileSourceParams) {
  const params = buildFilterParams(
    filter ? filterToJson(filter) : null,
    tickFilterParam,
    yearTickYear,
    countryTickCountry,
  );
  params.set("data_version", String(dataVersion));
  const queryString = params.toString();
  const suffix = queryString ? `?${queryString}` : "";
  return getApiUrl(`${buildApiUrl(TILE_ROUTE, { upload_id: uploadId })}.pbf${suffix}`);
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
