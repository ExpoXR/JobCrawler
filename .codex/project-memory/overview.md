# ExpoJobCrawler Overview

- DACH-first geographic employment research application.
- Stack: Next.js 16 web, TypeScript BullMQ worker, PostgreSQL 16 with PostGIS/pgvector, Redis, and self-hosted Nominatim 5.3.
- Public launch remains no-index by default. Only the web service binds to host loopback; data and geocoding services use `expojobcrawler-internal`.
- Canonical product marker: `data-expo-product="expojobcrawler"`, workspace profile, orange product accent.
