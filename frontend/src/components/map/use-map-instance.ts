import { MutableRefObject, useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";

type TransformRequest = (
  url: string,
  resourceType?: maplibregl.ResourceType,
) => maplibregl.RequestParameters;

type UseMapInstanceOptions = {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  uploadId: string;
  onReady?: (map: maplibregl.Map) => void;
  transformRequest?: TransformRequest;
};

export function useMapInstance({
  containerRef,
  uploadId,
  onReady,
  transformRequest,
}: UseMapInstanceOptions) {
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }

    const map = new maplibregl.Map({
      container,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [0, 20],
      zoom: 2,
      pixelRatio: typeof window !== "undefined" ? window.devicePixelRatio * 1.5 : 1,
      transformRequest,
    });

    collapseAttribution(map);
    map.scrollZoom.setZoomRate(1 / 225);

    mapRef.current = map;
    if (onReady) {
      map.once("load", () => onReady(map));
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [containerRef, uploadId, onReady, transformRequest]);

  return mapRef;
}
function collapseAttribution(map: maplibregl.Map) {
  const container = map.getContainer();
  const observer = new MutationObserver(() => {
    const attribElement = container.querySelector(".maplibregl-ctrl-attrib") as
      | HTMLElement
      | null;
    if (attribElement) {
      attribElement.classList.add("maplibregl-compact");
      attribElement.classList.remove("maplibregl-compact-show");
      observer.disconnect();
    }
  });

  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });

  requestAnimationFrame(() => {
    const attribElement = container.querySelector(".maplibregl-ctrl-attrib") as
      | HTMLElement
      | null;
    if (attribElement) {
      attribElement.classList.add("maplibregl-compact");
      attribElement.classList.remove("maplibregl-compact-show");
      observer.disconnect();
    }
  });
}
