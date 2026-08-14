'use client';

import type { GeoPoint, SearchResultItem } from '@ejc/shared';
import { useEffect, useMemo, useRef } from 'react';

/**
 * OpenStreetMap result map (plan sections 26 and 27).
 *
 * MapLibre is loaded lazily on the client only, so the server bundle stays free
 * of it and the page still renders without WebGL.
 *
 * Markers encode their category by *shape as well as colour* — circle for a
 * vacancy, square for a potential employer, diamond for a candidate — because
 * colour alone is not an accessible signal.
 */

export interface ResultMapProps {
  center: GeoPoint;
  radiusKm: number;
  items: SearchResultItem[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

interface MarkerModel {
  id: string;
  point: GeoPoint;
  kind: SearchResultItem['kind'];
  score: number;
  label: string;
}

function pointOf(item: SearchResultItem): GeoPoint | undefined {
  return item.job?.coordinates ?? item.company?.location ?? item.candidate?.coordinates;
}

function labelOf(item: SearchResultItem): string {
  if (item.kind === 'candidate') return item.candidate?.publicName ?? 'Public profile';
  if (item.kind === 'potential_employer') return item.company?.name ?? 'Company';
  return item.job?.title ?? 'Vacancy';
}

function colorFor(score: number): string {
  if (score >= 75) return '#0d7a4a';
  if (score >= 50) return '#9a5b00';
  return '#5b6472';
}

/** Builds the marker element: shape by kind, colour by match band. */
function markerElement(marker: MarkerModel): HTMLElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.setAttribute('aria-label', `${marker.label}, ${Math.round(marker.score)} percent match`);
  element.style.width = '18px';
  element.style.height = '18px';
  element.style.cursor = 'pointer';
  element.style.background = 'transparent';
  element.style.border = `3px solid ${colorFor(marker.score)}`;
  element.style.boxSizing = 'border-box';
  element.style.padding = '0';

  if (marker.kind === 'job') {
    element.style.borderRadius = '50%';
    element.style.backgroundColor = colorFor(marker.score);
  } else if (marker.kind === 'potential_employer') {
    element.style.borderRadius = '2px';
  } else {
    element.style.borderRadius = '2px';
    element.style.transform = 'rotate(45deg)';
  }

  return element;
}

export function ResultMap({ center, radiusKm, items, selectedId, onSelect }: ResultMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);
  const markersRef = useRef<Array<{ remove: () => void }>>([]);
  const failedRef = useRef(false);

  const markers = useMemo<MarkerModel[]>(
    () =>
      items
        .map((item) => {
          const point = pointOf(item);
          if (!point) return undefined;
          return {
            id: item.id,
            point,
            kind: item.kind,
            score: item.match.score,
            label: labelOf(item),
          } satisfies MarkerModel;
        })
        .filter((entry): entry is MarkerModel => entry !== undefined),
    [items],
  );

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
                tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                tileSize: 256,
                attribution: '© OpenStreetMap contributors',
                maxzoom: 19,
              },
            },
            layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
          },
          center: [center.lon, center.lat],
          zoom: radiusKm > 100 ? 7 : radiusKm > 40 ? 8.5 : 10,
          attributionControl: { compact: true },
        });

        map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
        map.addControl(new maplibre.ScaleControl({ unit: 'metric' }), 'bottom-left');
        mapRef.current = map;
      } catch {
        // No WebGL, blocked tiles, or an offline deployment: fall back to the
        // list-only view rather than breaking the page.
        failedRef.current = true;
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

      for (const marker of markers.slice(0, 400)) {
        const element = markerElement(marker);
        element.addEventListener('click', (event) => {
          event.stopPropagation();
          onSelect(marker.id);
        });
        if (marker.id === selectedId) {
          element.style.outline = '3px solid #1f5eff';
          element.style.outlineOffset = '2px';
        }

        const instance = new maplibre.Marker({ element })
          .setLngLat([marker.point.lon, marker.point.lat])
          .setPopup(
            new maplibre.Popup({ offset: 14, closeButton: false }).setText(
              `${marker.label} — ${Math.round(marker.score)}%`,
            ),
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
    <div>
      <div className="map-container" ref={containerRef} role="application" aria-label="Result map">
        {markers.length === 0 ? (
          <div className="map-fallback">
            No mappable results yet. Results without coordinates still appear in the list.
          </div>
        ) : null}
      </div>
      <div className="map-legend" aria-hidden="false">
        <span className="swatch">
          <span className="dot job" /> Active vacancy (circle)
        </span>
        <span className="swatch">
          <span className="dot potential" /> Potential employer (square)
        </span>
        <span className="swatch">
          <span className="dot candidate" /> Candidate (diamond)
        </span>
        <span>Border colour indicates match strength.</span>
      </div>
    </div>
  );
}
