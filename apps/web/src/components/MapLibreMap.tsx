'use client';

import type { GeoPoint } from '@ejc/shared';
import { useEffect, useRef, useState } from 'react';

import {
  MAX_MARKERS,
  markerAriaLabel,
  markerTitle,
  matchColorToken,
  zoomForRadius,
  type MarkerModel,
} from '@/lib/mapMarkers';

/**
 * The default map: MapLibre over raster OpenStreetMap tiles.
 *
 * This is the body of what used to be `ResultMap`, unchanged in behaviour. It is
 * separate now only so `ResultMap` can choose between it and the Google
 * implementation without either knowing about the other.
 *
 * MapLibre is imported lazily on the client, so the server bundle stays free of
 * it and the page still renders without WebGL.
 */

export interface MapLibreMapProps {
  center: GeoPoint;
  radiusKm: number;
  markers: MarkerModel[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

const MAP_TILE_URL =
  process.env.NEXT_PUBLIC_MAP_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

function markerColor(score: number): string {
  const { token, fallback } = matchColorToken(score);
  return `var(${token}, ${fallback})`;
}

/** Builds the marker element: shape by kind, colour by match band. */
function markerElement(marker: MarkerModel): HTMLElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.setAttribute('aria-label', markerAriaLabel(marker));
  element.style.width = '18px';
  element.style.height = '18px';
  element.style.cursor = 'pointer';
  element.style.background = 'transparent';
  element.style.border = `3px solid ${markerColor(marker.score)}`;
  element.style.boxSizing = 'border-box';
  element.style.padding = '0';

  if (marker.kind === 'job') {
    element.style.borderRadius = '50%';
    element.style.backgroundColor = markerColor(marker.score);
  } else if (marker.kind === 'potential_employer') {
    element.style.borderRadius = '2px';
  } else {
    element.style.borderRadius = '2px';
    element.style.transform = 'rotate(45deg)';
  }

  return element;
}

export function MapLibreMap({
  center,
  radiusKm,
  markers,
  selectedId,
  onSelect,
}: MapLibreMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);
  const markersRef = useRef<Array<{ remove: () => void }>>([]);
  const failedRef = useRef(false);
  const [mapFailed, setMapFailed] = useState(false);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!containerRef.current || mapRef.current || failedRef.current) return;
      try {
        const maplibre = await import('maplibre-gl');
        if (cancelled || !containerRef.current) return;

        const map = new maplibre.Map({
          container: containerRef.current,
          // Raster OSM tiles keep the deployment free of any API key.
          style: {
            version: 8,
            sources: {
              osm: {
                type: 'raster',
                tiles: [MAP_TILE_URL],
                tileSize: 256,
                attribution: '© OpenStreetMap contributors',
                maxzoom: 19,
              },
            },
            layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
          },
          center: [center.lon, center.lat],
          zoom: zoomForRadius(radiusKm),
          attributionControl: { compact: true },
        });

        map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
        map.addControl(new maplibre.ScaleControl({ unit: 'metric' }), 'bottom-left');
        map.on('error', () => setMapFailed(true));
        mapRef.current = map;
      } catch {
        // No WebGL, blocked tiles, or an offline deployment: fall back to the
        // list-only view rather than breaking the page.
        failedRef.current = true;
        setMapFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [center.lat, center.lon, radiusKm]);

  // Re-render markers whenever results change.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const map = mapRef.current as
        | { addControl: unknown; setCenter: (value: [number, number]) => void }
        | null;
      if (!map) return;

      const maplibre = await import('maplibre-gl').catch(() => undefined);
      if (!maplibre || cancelled) return;

      for (const marker of markersRef.current) marker.remove();
      markersRef.current = [];

      for (const marker of markers.slice(0, MAX_MARKERS)) {
        const element = markerElement(marker);
        element.addEventListener('click', (event) => {
          event.stopPropagation();
          onSelect(marker.id);
        });
        if (marker.id === selectedId) {
          element.style.outline = '3px solid var(--ex-accent)';
          element.style.outlineOffset = '2px';
        }

        const instance = new maplibre.Marker({ element })
          .setLngLat([marker.point.lon, marker.point.lat])
          .setPopup(
            new maplibre.Popup({ offset: 14, closeButton: false }).setText(markerTitle(marker)),
          )
          .addTo(map as never);

        markersRef.current.push(instance);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [markers, selectedId, onSelect]);

  // Keep the map centred on the search location when the query changes.
  useEffect(() => {
    const map = mapRef.current as { setCenter?: (value: [number, number]) => void } | null;
    map?.setCenter?.([center.lon, center.lat]);
  }, [center.lat, center.lon]);

  return (
    <div className="map-container" ref={containerRef} role="region" aria-label="Result map">
      {mapFailed ? (
        <div className="map-fallback map-fallback--error" role="status">
          The interactive map is unavailable. All results remain available in the list.
        </div>
      ) : markers.length === 0 ? (
        <div className="map-fallback">
          No mappable results yet. Results without coordinates still appear in the list.
        </div>
      ) : null}
    </div>
  );
}
