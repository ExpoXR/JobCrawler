/**
 * Session-scoped storage for a Google Maps JavaScript API key.
 *
 * The key is supplied by the person looking at the map, not by the operator, and
 * it is deliberately never sent to this server: not in a request body, not in a
 * cookie, not in a log line. It lives in `sessionStorage`, which is scoped to
 * one tab and cleared when that tab closes, and it additionally expires after a
 * period of inactivity so an unattended browser does not keep it indefinitely.
 *
 * A Maps JavaScript key is not a secret in the way an API token is — it travels
 * in the URL of every tile request and is visible to anyone with the tab open —
 * which is exactly why it must be restricted by HTTP referrer in Google Cloud.
 * `docs/maps.md` says so at the point where the key is created, and the UI
 * repeats it at the point where it is pasted.
 *
 * These functions take the storage object as an argument rather than reaching
 * for `window`, so they can be tested outside a browser.
 */

export const MAPS_KEY_STORAGE_KEY = 'expojobcrawler:maps-key';

/** Idle window after which a stored key is dropped, even in a tab left open. */
export const MAPS_KEY_IDLE_MS = 30 * 60 * 1000;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredKey {
  key: string;
  touchedAt: number;
}

/** Whether the Google option exists at all on this deployment. */
export function googleMapsAllowed(): boolean {
  return process.env.NEXT_PUBLIC_MAP_PROVIDER_ALLOW_GOOGLE === 'true';
}

/**
 * Shape check, not a validity check — only Google can say whether a key works.
 *
 * It rejects the two things people actually paste by mistake: a whole console
 * URL, and a value with surrounding quotes or a trailing newline. Both would
 * otherwise reach the Maps loader and fail with a message that explains nothing.
 */
export function isPlausibleMapsKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,128}$/.test(value.trim());
}

function isStoredKey(value: unknown): value is StoredKey {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StoredKey>;
  return typeof candidate.key === 'string' && typeof candidate.touchedAt === 'number';
}

/**
 * Reads the stored key, dropping it if the idle window has passed.
 *
 * Anything unparseable is treated as absent and removed: the only way to get a
 * malformed envelope in here is a version skew or a hand-edited storage entry,
 * and neither is worth carrying forward.
 */
export function readMapsKey(storage: StorageLike, now: number = Date.now()): string | undefined {
  const raw = storage.getItem(MAPS_KEY_STORAGE_KEY);
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    storage.removeItem(MAPS_KEY_STORAGE_KEY);
    return undefined;
  }

  if (!isStoredKey(parsed) || !isPlausibleMapsKey(parsed.key)) {
    storage.removeItem(MAPS_KEY_STORAGE_KEY);
    return undefined;
  }

  if (now - parsed.touchedAt > MAPS_KEY_IDLE_MS) {
    storage.removeItem(MAPS_KEY_STORAGE_KEY);
    return undefined;
  }

  return parsed.key;
}

/** Stores a key and starts its idle window. Returns false for a malformed key. */
export function writeMapsKey(
  storage: StorageLike,
  key: string,
  now: number = Date.now(),
): boolean {
  const trimmed = key.trim();
  if (!isPlausibleMapsKey(trimmed)) return false;
  storage.setItem(MAPS_KEY_STORAGE_KEY, JSON.stringify({ key: trimmed, touchedAt: now }));
  return true;
}

/** Restarts the idle window without changing the key. */
export function touchMapsKey(storage: StorageLike, now: number = Date.now()): void {
  const key = readMapsKey(storage, now);
  if (key) writeMapsKey(storage, key, now);
}

export function forgetMapsKey(storage: StorageLike): void {
  storage.removeItem(MAPS_KEY_STORAGE_KEY);
}

/**
 * Clears the key from this tab's storage, tolerating every environment where
 * `sessionStorage` is unavailable (server rendering, Safari private mode, a
 * browser configured to block storage). Used on sign-out, where the caller has
 * no useful response to a failure.
 */
export function forgetMapsKeyInSession(): void {
  try {
    window.sessionStorage.removeItem(MAPS_KEY_STORAGE_KEY);
  } catch {
    // Storage disabled: there was nothing to clear.
  }
}

/**
 * The Maps JavaScript loader URL.
 *
 * `loading=async` is what Google asks for when the script is injected rather
 * than written into the document, and it silences a console warning that would
 * otherwise appear on every load. `v=weekly` pins the channel, not a version:
 * the alternative is `v=beta`, which is not something to run unattended.
 */
export function mapsScriptUrl(key: string, callbackName: string): string {
  const params = new URLSearchParams({
    key,
    v: 'weekly',
    loading: 'async',
    callback: callbackName,
  });
  return `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
}
