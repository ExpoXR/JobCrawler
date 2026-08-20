'use client';

import type { GeoPoint, SearchResultItem } from '@ejc/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { toMarkers } from '@/lib/mapMarkers';
import {
  forgetMapsKey,
  googleMapsAllowed,
  readMapsKey,
  touchMapsKey,
  writeMapsKey,
  type StorageLike,
} from '@/lib/mapsKey';

import { GoogleMap } from './GoogleMap';
import { MapLibreMap } from './MapLibreMap';

/**
 * The map shell: provider choice, key handling, and the legend both maps share.
 *
 * Rendering lives in `MapLibreMap` and `GoogleMap`; neither knows the other
 * exists. Marker semantics are identical between them (circle = vacancy,
 * square = potential employer, diamond = candidate; colour by match band), which
 * is why the legend can sit out here and stay true for both.
 *
 * MapLibre over OpenStreetMap is the default and the fallback. Google Maps
 * appears only where the operator has enabled it *and* the viewer supplies
 * their own key, which never leaves the browser.
 */

export interface ResultMapProps {
  center: GeoPoint;
  radiusKm: number;
  items: SearchResultItem[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

type MapProvider = 'osm' | 'google';

const PROVIDER_STORAGE_KEY = 'expojobcrawler:map-provider';

/** How often the idle expiry of a stored key is noticed by an open tab. */
const KEY_POLL_MS = 60_000;

/**
 * Storage can be unavailable — server rendering, private browsing, a browser
 * configured to block it. None of that should break the map, so every access
 * degrades to "no stored value" rather than throwing.
 */
function sessionStore(): StorageLike | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function localStore(): StorageLike | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function ResultMap({ center, radiusKm, items, selectedId, onSelect }: ResultMapProps) {
  const markers = useMemo(() => toMarkers(items), [items]);
  const allowGoogle = googleMapsAllowed();

  const [provider, setProvider] = useState<MapProvider>('osm');
  const [apiKey, setApiKey] = useState<string | undefined>(undefined);
  const [draftKey, setDraftKey] = useState('');
  const [keyError, setKeyError] = useState<string | undefined>(undefined);

  // Restore the provider choice and any key this tab already holds.
  useEffect(() => {
    if (!allowGoogle) return;
    const stored = localStore()?.getItem(PROVIDER_STORAGE_KEY);
    if (stored === 'google') setProvider('google');
    const session = sessionStore();
    if (session) setApiKey(readMapsKey(session));
  }, [allowGoogle]);

  /*
   * The key expires after a period of inactivity, which is only meaningful if
   * an idle tab notices. Polling beats a timeout because the idle window is
   * restarted by interaction, and a poll cannot drift out of step with it.
   */
  useEffect(() => {
    if (!apiKey) return;
    const timer = window.setInterval(() => {
      const session = sessionStore();
      if (!session || !readMapsKey(session)) setApiKey(undefined);
    }, KEY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [apiKey]);

  const chooseProvider = useCallback((next: MapProvider) => {
    setProvider(next);
    localStore()?.setItem(PROVIDER_STORAGE_KEY, next);
  }, []);

  const submitKey = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const session = sessionStore();
      if (!session) {
        setKeyError('This browser is blocking session storage, so the key cannot be held.');
        return;
      }
      if (!writeMapsKey(session, draftKey)) {
        setKeyError('That does not look like a Maps API key. Paste the key itself, not a URL.');
        return;
      }
      setKeyError(undefined);
      setApiKey(draftKey.trim());
      setDraftKey('');
    },
    [draftKey],
  );

  const forgetKey = useCallback(() => {
    const session = sessionStore();
    if (session) forgetMapsKey(session);
    setApiKey(undefined);
  }, []);

  /** Any interaction with the map restarts the key's idle window. */
  const keepAlive = useCallback(() => {
    if (!apiKey) return;
    const session = sessionStore();
    if (session) touchMapsKey(session);
  }, [apiKey]);

  const useGoogle = allowGoogle && provider === 'google' && apiKey !== undefined;

  return (
    <div className="map-shell" onPointerDown={keepAlive} onKeyDown={keepAlive}>
      {allowGoogle ? (
        <fieldset className="map-toolbar">
          <legend className="visually-hidden">Map provider</legend>
          <label className="checkbox-row">
            <input
              type="radio"
              name="map-provider"
              checked={provider === 'osm'}
              onChange={() => chooseProvider('osm')}
            />
            OpenStreetMap
          </label>
          <label className="checkbox-row">
            <input
              type="radio"
              name="map-provider"
              checked={provider === 'google'}
              onChange={() => chooseProvider('google')}
            />
            Google Maps
          </label>
          {useGoogle ? (
            <button type="button" className="link-button" onClick={forgetKey}>
              Forget key
            </button>
          ) : null}
        </fieldset>
      ) : null}

      {allowGoogle && provider === 'google' && !apiKey ? (
        <form className="map-key-form" onSubmit={submitKey}>
          <label htmlFor="maps-key">Google Maps API key</label>
          <div className="map-key-row">
            <input
              id="maps-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draftKey}
              placeholder="AIza…"
              onChange={(event) => setDraftKey(event.target.value)}
            />
            <button type="submit" className="button" disabled={draftKey.trim().length === 0}>
              Use key
            </button>
          </div>
          {keyError ? (
            <p className="notice error" role="alert">
              {keyError}
            </p>
          ) : null}
          <p className="hint">
            The key stays in this browser tab, is never sent to this server, and is discarded when
            the tab closes, when you sign out, or after 30 minutes without interaction. A Maps
            JavaScript key is visible to anyone using this tab, so restrict it by HTTP referrer and
            by API in Google Cloud before pasting it here. See <code>docs/maps.md</code>.
          </p>
        </form>
      ) : null}

      {useGoogle && apiKey ? (
        <GoogleMap
          center={center}
          radiusKm={radiusKm}
          markers={markers}
          selectedId={selectedId}
          onSelect={onSelect}
          apiKey={apiKey}
          onKeyRejected={forgetKey}
        />
      ) : (
        <MapLibreMap
          center={center}
          radiusKm={radiusKm}
          markers={markers}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      )}

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
