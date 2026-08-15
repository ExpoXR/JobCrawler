import { describe, expect, it } from 'vitest';

import { boundingBox, haversineKm, isValidPoint } from './geo';

const KEMPTEN = { lat: 47.7267, lon: 10.3168 };
const MUNICH = { lat: 48.1372, lon: 11.5756 };

describe('haversineKm', () => {
  it('matches a known distance', () => {
    // Kempten → Munich is roughly 100 km as the crow flies.
    expect(haversineKm(KEMPTEN, MUNICH)).toBeGreaterThan(95);
    expect(haversineKm(KEMPTEN, MUNICH)).toBeLessThan(105);
  });

  it('is zero for the same point and symmetric', () => {
    expect(haversineKm(KEMPTEN, KEMPTEN)).toBe(0);
    expect(haversineKm(KEMPTEN, MUNICH)).toBeCloseTo(haversineKm(MUNICH, KEMPTEN), 6);
  });

  it('handles antipodal-ish points without NaN', () => {
    const distance = haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 });
    expect(Number.isFinite(distance)).toBe(true);
    expect(distance).toBeGreaterThan(20_000);
  });
});

describe('boundingBox', () => {
  it('contains the centre and the radius edge', () => {
    const box = boundingBox(KEMPTEN, 50);
    expect(box.minLat).toBeLessThan(KEMPTEN.lat);
    expect(box.maxLat).toBeGreaterThan(KEMPTEN.lat);
    expect(box.minLon).toBeLessThan(KEMPTEN.lon);
    expect(box.maxLon).toBeGreaterThan(KEMPTEN.lon);
  });

  it('clamps at the poles instead of producing invalid coordinates', () => {
    const box = boundingBox({ lat: 89.9, lon: 0 }, 500);
    expect(box.maxLat).toBeLessThanOrEqual(90);
    expect(box.minLon).toBeGreaterThanOrEqual(-180);
    expect(box.maxLon).toBeLessThanOrEqual(180);
  });
});

describe('isValidPoint', () => {
  it('rejects malformed input', () => {
    expect(isValidPoint(undefined)).toBe(false);
    expect(isValidPoint({ lat: 'a', lon: 1 })).toBe(false);
    expect(isValidPoint({ lat: 91, lon: 0 })).toBe(false);
    expect(isValidPoint({ lat: 0, lon: 181 })).toBe(false);
    expect(isValidPoint({ lat: Number.NaN, lon: 0 })).toBe(false);
  });

  it('accepts valid coordinates', () => {
    expect(isValidPoint(KEMPTEN)).toBe(true);
  });
});
