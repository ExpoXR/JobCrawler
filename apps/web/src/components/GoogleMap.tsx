'use client';

import type { GeoPoint } from '@ejc/shared';
import { useEffect, useRef, useState } from 'react';

import {
  MAX_MARKERS,
  markerTitle,
  matchColorToken,
  zoomForRadius,
  type ColorToken,
  type MarkerModel,
} from '@/lib/mapMarkers';
import { mapsScriptUrl } from '@/lib/mapsKey';

/**
 * Google Maps rendering, used only when the deployment allows it and the viewer
 * has supplied their own key.
 *
 * The key reaches this component as a prop and is used for exactly one thing:
 * the loader URL. It is never stored here, never sent to this server, and never
 * logged. See `apps/web/src/lib/mapsKey.ts` for where it lives.
 *
 * Google is deliberately *not* the default. MapLibre needs no key, no billing
 * account and no third-party request from the viewer's browser, and its markers
 * are real DOM buttons, which the Maps API's are not — so the list stays the
 * accessible path here in a way it does not have to be on the default map.
 *
 * The API is typed structurally below rather than by adding `@types/google.maps`:
 * this component uses four constructors and one enum, and a dependency for that
 * is not worth the supply-chain surface.
 */

export interface GoogleMapProps {
  center: GeoPoint;
  radiusKm: number;
  markers: MarkerModel[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  apiKey: string;
  /** Called when Google rejects the key, so the shell can ask for another. */
  onKeyRejected: () => void;
}

interface LatLngLiteral {
  lat: number;
  lng: number;
}

interface GoogleMapInstance {
  setCenter(position: LatLngLiteral): void;
}

interface GoogleMarkerInstance {
  setMap(map: GoogleMapInstance | null): void;
  addListener(event: string, handler: () => void): void;
}

interface GoogleMapsApi {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => GoogleMapInstance;
  Marker: new (options: Record<string, unknown>) => GoogleMarkerInstance;
  SymbolPath: { CIRCLE: number };
}

/** Marker outlines drawn by the Maps API, which cannot resolve `var(--…)`. */
function resolveColor({ token, fallback }: ColorToken): string {
  if (typeof window === 'undefined') return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value || fallback;
}

const SQUARE_PATH = 'M -6 -6 L 6 -6 L 6 6 L -6 6 Z';
const DIAMOND_PATH = 'M 0 -8 L 8 0 L 0 8 L -8 0 Z';

/** Same semantics as the MapLibre markers: shape by kind, colour by band. */
function iconFor(api: GoogleMapsApi, marker: MarkerModel, selected: boolean): Record<string, unknown> {
  const color = resolveColor(matchColorToken(marker.score));
  const shared = {
    fillColor: color,
    strokeColor: selected ? resolveColor({ token: '--ex-accent', fallback: '#1a4fd6' }) : color,
    strokeWeight: selected ? 4 : 3,
    fillOpacity: marker.kind === 'job' ? 1 : 0,
  };

  if (marker.kind === 'job') return { ...shared, path: api.SymbolPath.CIRCLE, scale: 8 };
  if (marker.kind === 'potential_employer') return { ...shared, path: SQUARE_PATH, scale: 1 };
  return { ...shared, path: DIAMOND_PATH, scale: 1 };
}

/**
 * Loads the Maps JavaScript API once per key.
 *
 * Google's loader is a singleton: injecting it twice logs a warning and can
 * leave the API in a state where the second load never resolves. The promise is
 * cached at module scope so a re-render, a provider switch, or a second map on
 * the page all wait on the same script element.
 *
 * Keyed by the API key so that correcting a rejected key actually retries
 * instead of resolving against the failed load.
 */
const loaders = new Map<string, Promise<GoogleMapsApi>>();

function loadMapsApi(apiKey: string): Promise<GoogleMapsApi> {
  const existing = loaders.get(apiKey);
  if (existing) return existing;

  const promise = new Promise<GoogleMapsApi>((resolve, reject) => {
    const callbackName = `__ejcMapsReady${loaders.size}`;
    const globals = window as unknown as Record<string, unknown>;

    globals[callbackName] = () => {
      delete globals[callbackName];
      const maps = (globals['google'] as { maps?: GoogleMapsApi } | undefined)?.maps;
      if (maps) resolve(maps);
      else reject(new Error('Maps API loaded without an API object'));
    };

    const script = document.createElement('script');
    script.src = mapsScriptUrl(apiKey, callbackName);
    script.async = true;
    script.onerror = () => {
      delete globals[callbackName];
      reject(new Error('Could not load the Google Maps API'));
    };
    document.head.appendChild(script);
  });

  // A failed load must not be cached, or a corrected key would never retry.
  promise.catch(() => loaders.delete(apiKey));
  loaders.set(apiKey, promise);
  return promise;
}

export function GoogleMap({
  center,
  radiusKm,
  markers,
  selectedId,
  onSelect,
  apiKey,
  onKeyRejected,
}: GoogleMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<GoogleMapsApi | null>(null);
  const mapRef = useRef<GoogleMapInstance | null>(null);
  const markersRef = useRef<GoogleMarkerInstance[]>([]);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [ready, setReady] = useState(false);

  /*
   * An invalid, expired or referrer-restricted key does not fail the script
   * load — the map renders grey and the API calls a global. Without this hook
   * the viewer sees a broken map and no explanation.
   */
  useEffect(() => {
    const globals = window as unknown as Record<string, unknown>;
    const previous = globals['gm_authFailure'];
    globals['gm_authFailure'] = () => {
      setFailure(
        'Google rejected this API key. Check that the Maps JavaScript API is enabled, that ' +
          'billing is active, and that this site matches the key’s HTTP referrer restriction.',
      );
      onKeyRejected();
    };
    return () => {
      globals['gm_authFailure'] = previous;
    };
  }, [onKeyRejected]);

  // Create the map once per key.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!containerRef.current) return;
      try {
        const api = await loadMapsApi(apiKey);
        if (cancelled || !containerRef.current) return;

        apiRef.current = api;
        mapRef.current = new api.Map(containerRef.current, {
          center: { lat: center.lat, lng: center.lon },
          zoom: zoomForRadius(radiusKm),
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });
        setReady(true);
      } catch {
        if (!cancelled) {
          setFailure('The Google map could not be loaded. All results remain available in the list.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the API key alone: `center` and `radiusKm` seed the
    // initial view, and later changes are applied by the recentre effect below
    // rather than by tearing down and rebuilding the map.
  }, [apiKey]);

  // Re-render markers whenever results change.
  useEffect(() => {
    const api = apiRef.current;
    const map = mapRef.current;
    if (!api || !map || !ready) return;

    for (const marker of markersRef.current) marker.setMap(null);
    markersRef.current = [];

    for (const marker of markers.slice(0, MAX_MARKERS)) {
      const selected = marker.id === selectedId;
      const instance = new api.Marker({
        map,
        position: { lat: marker.point.lat, lng: marker.point.lon },
        title: markerTitle(marker),
        icon: iconFor(api, marker, selected),
        zIndex: selected ? 1000 : undefined,
        clickable: true,
      });
      instance.addListener('click', () => onSelect(marker.id));
      markersRef.current.push(instance);
    }
  }, [markers, selectedId, onSelect, ready]);

  // Drop every marker on unmount; the map itself is garbage-collected with the node.
  useEffect(
    () => () => {
      for (const marker of markersRef.current) marker.setMap(null);
      markersRef.current = [];
    },
    [],
  );

  // Keep the map centred on the search location when the query changes.
  useEffect(() => {
    mapRef.current?.setCenter({ lat: center.lat, lng: center.lon });
  }, [center.lat, center.lon]);

  return (
    <div className="map-container" ref={containerRef} role="region" aria-label="Result map">
      {failure ? (
        <div className="map-fallback map-fallback--error" role="status">
          {failure}
        </div>
      ) : markers.length === 0 ? (
        <div className="map-fallback">
          No mappable results yet. Results without coordinates still appear in the list.
        </div>
      ) : null}
    </div>
  );
}
