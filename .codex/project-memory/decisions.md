# Decisions

- Launch region is Germany, Austria and Switzerland using the Geofabrik DACH extract and daily replication diffs.
- Nominatim has no published host port and shares only the explicit application Docker network.
- Public OpenStreetMap raster tiles remain the launch default; the browser-facing URL is build-configurable and attribution is never removed.
- The app is `noindex` unless `PUBLIC_ROBOTS_NOINDEX=false` is deliberately supplied at build time.
- Nominatim readiness is a core health dependency because location search cannot complete correctly without geocoding.
- Overpass uses an identified `ExpoXR-Research` user agent because the public FOSSGIS endpoint rejects the `Crawler` token; the OpenStreetMap-listed Private.coffee instance is the automatic fallback for transient 429/504 failures.
- BullMQ custom job IDs are URI-encoded centrally because version 5 reserves `:` for Redis key construction.
- The imported Nominatim dataset is protected by the verified `auto-2026-08-16_17-14` local and USB snapshots.
