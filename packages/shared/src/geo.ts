import type { GeoPoint } from './types';

const EARTH_RADIUS_KM = 6371.0088;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/**
 * Axis-aligned bounding box around a point. Used to pre-filter Overpass and
 * PostGIS queries before the exact radius test.
 */
export function boundingBox(center: GeoPoint, radiusKm: number): BoundingBox {
  const latDelta = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  const cosLat = Math.cos(toRadians(center.lat));
  // Near the poles the longitude delta explodes; clamp to the whole range.
  const lonDelta = Math.abs(cosLat) < 1e-6 ? 180 : latDelta / Math.abs(cosLat);

  return {
    minLat: Math.max(-90, center.lat - latDelta),
    maxLat: Math.min(90, center.lat + latDelta),
    minLon: Math.max(-180, center.lon - lonDelta),
    maxLon: Math.min(180, center.lon + lonDelta),
  };
}

export function isValidPoint(point: unknown): point is GeoPoint {
  if (!point || typeof point !== 'object') return false;
  const { lat, lon } = point as Partial<GeoPoint>;
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}
