"use client";

import { useRef, useEffect } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

interface SightingsMapProps {
  uploadId: string;
}

export function SightingsMap({ uploadId }: SightingsMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

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
    });

    map.on("load", () => {
      map.addSource("sightings", {
        type: "vector",
        tiles: [`http://localhost:3001/api/tiles/${uploadId}/{z}/{x}/{y}.pbf`],
      });

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
        const count = feature.properties?.count || 1;

        new maplibregl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(`<strong>${name}</strong><br/>Count: ${count}`)
          .addTo(map);
      });

      map.on("mouseenter", "sightings-circles", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "sightings-circles", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [uploadId]);

  return <div ref={containerRef} className="h-full w-full" />;
}
