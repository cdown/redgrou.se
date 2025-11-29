"use client";

import { useRef, useEffect } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { FilterGroup, filterToJson } from "@/lib/filter-types";
import { fetchSpeciesInfo } from "@/lib/species-api";

interface SightingsMapProps {
  uploadId: string;
  filter: FilterGroup | null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).replace(/\s+\S*$/, "") + "…";
}

function createPopupContent(
  name: string,
  count: number,
  scientificName?: string,
): HTMLDivElement {
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
            <div style="font-weight: 600; font-size: 15px; color: #111827; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${name}</div>
            ${scientificName ? `<div style="font-size: 13px; color: #6b7280; font-style: italic;">${scientificName}</div>` : ""}
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
    wikipediaUrl: string | null;
    observationsCount: number | null;
  } | null,
): void {
  if (!info) {
    container.innerHTML = `
      <div style="width: 280px; font-family: system-ui, -apple-system, sans-serif;">
        <div style="padding: 12px;">
          <div style="font-weight: 600; font-size: 15px; color: #111827; margin-bottom: 4px;">${name}</div>
          <div style="font-size: 13px; color: #6b7280;">Count: ${count}</div>
        </div>
      </div>
    `;
    return;
  }

  const summary = info.wikipediaSummary
    ? truncateText(stripHtml(info.wikipediaSummary), 200)
    : null;

  container.innerHTML = `
    <div style="width: 300px; font-family: system-ui, -apple-system, sans-serif; overflow: hidden; border-radius: 8px;">
      ${
        info.photoUrl
          ? `<div style="position: relative;">
              <img
                src="${info.photoUrl}"
                alt="${info.commonName}"
                style="width: 100%; height: 160px; object-fit: cover; display: block;"
              />
              <div style="position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,0.7)); padding: 8px 12px;">
                <div style="font-weight: 600; font-size: 16px; color: white;">${info.commonName}</div>
                <div style="font-size: 13px; color: rgba(255,255,255,0.85); font-style: italic;">${info.scientificName}</div>
              </div>
            </div>`
          : `<div style="padding: 12px 12px 0;">
              <div style="font-weight: 600; font-size: 16px; color: #111827;">${info.commonName}</div>
              <div style="font-size: 13px; color: #6b7280; font-style: italic;">${info.scientificName}</div>
            </div>`
      }
      <div style="padding: 12px;">
        ${summary ? `<p style="font-size: 13px; line-height: 1.5; color: #374151; margin: 0 0 10px;">${summary}</p>` : ""}
        <div style="display: flex; align-items: center; gap: 12px; padding-top: 8px; border-top: 1px solid #e5e7eb;">
          <div style="display: flex; align-items: center; gap: 4px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
            <span style="font-size: 12px; color: #6b7280;">Count: ${count}</span>
          </div>
          ${
            info.wikipediaUrl
              ? `<a href="${info.wikipediaUrl}" target="_blank" rel="noopener noreferrer" style="font-size: 12px; color: #2563eb; text-decoration: none; margin-left: auto;">Wikipedia →</a>`
              : ""
          }
        </div>
        ${
          info.photoAttribution
            ? `<div style="font-size: 10px; color: #9ca3af; margin-top: 8px;">Photo: ${info.photoAttribution}</div>`
            : ""
        }
      </div>
    </div>
  `;
}

export function SightingsMap({ uploadId, filter }: SightingsMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }

    const filterParam = filter
      ? `?filter=${encodeURIComponent(filterToJson(filter))}`
      : "";

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
        tiles: [
          `http://localhost:3001/api/tiles/${uploadId}/{z}/{x}/{y}.pbf${filterParam}`,
        ],
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
        const scientificName = feature.properties?.scientific_name;
        const count = feature.properties?.count || 1;
        const lngLat = e.lngLat;

        const popupContent = createPopupContent(name, count, scientificName);

        let popup = new maplibregl.Popup({
          maxWidth: "none",
          subpixelPositioning: false,
        })
          .setLngLat(lngLat)
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
            updatePopupWithSpeciesInfo(finalContent, name, count, info);
            popup = new maplibregl.Popup({
              maxWidth: "none",
              subpixelPositioning: false,
            })
              .setLngLat(lngLat)
              .setDOMContent(finalContent)
              .addTo(map);
          }
        });
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
  }, [uploadId, filter]);

  return <div ref={containerRef} className="h-full w-full" />;
}
