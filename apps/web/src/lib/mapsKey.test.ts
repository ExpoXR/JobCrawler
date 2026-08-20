import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAPS_KEY_IDLE_MS,
  MAPS_KEY_STORAGE_KEY,
  isPlausibleMapsKey,
  forgetMapsKey,
  mapsScriptUrl,
  readMapsKey,
  touchMapsKey,
  writeMapsKey,
  type StorageLike,
} from './mapsKey';

/** Enough of `Storage` to exercise the module without a DOM. */
class FakeStorage implements StorageLike {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

const KEY = 'AIzaSyA0000000000000000000000000000000';

describe('isPlausibleMapsKey', () => {
  it('accepts a key and trims around it', () => {
    expect(isPlausibleMapsKey(KEY)).toBe(true);
    expect(isPlausibleMapsKey(`  ${KEY}\n`)).toBe(true);
  });

  it('rejects what people paste by mistake', () => {
    expect(isPlausibleMapsKey(`https://maps.googleapis.com/maps/api/js?key=${KEY}`)).toBe(false);
    expect(isPlausibleMapsKey(`"${KEY}"`)).toBe(false);
    expect(isPlausibleMapsKey('short')).toBe(false);
    expect(isPlausibleMapsKey('')).toBe(false);
  });
});

describe('maps key storage', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
  });

  it('round-trips a key', () => {
    expect(writeMapsKey(storage, ` ${KEY} `, 1_000)).toBe(true);
    expect(readMapsKey(storage, 1_000)).toBe(KEY);
  });

  it('refuses to store a malformed key', () => {
    expect(writeMapsKey(storage, 'not a key', 0)).toBe(false);
    expect(storage.getItem(MAPS_KEY_STORAGE_KEY)).toBeNull();
  });

  it('drops the key once the idle window has passed', () => {
    writeMapsKey(storage, KEY, 0);
    expect(readMapsKey(storage, MAPS_KEY_IDLE_MS)).toBe(KEY);
    expect(readMapsKey(storage, MAPS_KEY_IDLE_MS + 1)).toBeUndefined();
    // The expired entry is removed, not merely hidden from this caller.
    expect(storage.getItem(MAPS_KEY_STORAGE_KEY)).toBeNull();
  });

  it('restarts the idle window on interaction', () => {
    writeMapsKey(storage, KEY, 0);
    touchMapsKey(storage, MAPS_KEY_IDLE_MS - 1);
    expect(readMapsKey(storage, MAPS_KEY_IDLE_MS + 1)).toBe(KEY);
  });

  it('does not resurrect a key that already expired', () => {
    writeMapsKey(storage, KEY, 0);
    touchMapsKey(storage, MAPS_KEY_IDLE_MS + 1);
    expect(readMapsKey(storage, MAPS_KEY_IDLE_MS + 2)).toBeUndefined();
  });

  it('treats an unparseable or hand-edited entry as absent', () => {
    storage.setItem(MAPS_KEY_STORAGE_KEY, 'not json');
    expect(readMapsKey(storage)).toBeUndefined();

    storage.setItem(MAPS_KEY_STORAGE_KEY, JSON.stringify({ key: 'x', touchedAt: Date.now() }));
    expect(readMapsKey(storage)).toBeUndefined();

    storage.setItem(MAPS_KEY_STORAGE_KEY, JSON.stringify({ key: KEY }));
    expect(readMapsKey(storage)).toBeUndefined();
  });

  it('forgets on request', () => {
    writeMapsKey(storage, KEY);
    forgetMapsKey(storage);
    expect(readMapsKey(storage)).toBeUndefined();
  });
});

describe('mapsScriptUrl', () => {
  it('builds the loader URL Google asks for when the script is injected', () => {
    const url = new URL(mapsScriptUrl(KEY, '__cb'));
    expect(url.origin + url.pathname).toBe('https://maps.googleapis.com/maps/api/js');
    expect(url.searchParams.get('key')).toBe(KEY);
    expect(url.searchParams.get('callback')).toBe('__cb');
    expect(url.searchParams.get('loading')).toBe('async');
  });
});
