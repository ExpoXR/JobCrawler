# Current State

## 2026-08-16

- ExpoXR workspace design is implemented across home, search, filters, results, map, admin, research and detail surfaces with local Manrope/JetBrains Mono fonts.
- Theme storage key is `expojobcrawler-theme`; light is default and pre-hydration resolution supports light, dark and system.
- Orange is reserved for product accent/selection; semantic success, warning and error roles remain distinct. Focus, skip navigation, keyboard, reduced-motion and mobile filter behavior are implemented.
- Map tiles are configurable through `NEXT_PUBLIC_MAP_TILE_URL`, retain OpenStreetMap attribution and provide an error fallback.
- Health output caches Nominatim readiness and returns a degraded 503 while geocoding is unavailable.
- Runtime dependencies are Next 16.3.1 and fast-xml-parser 5.11.0. Typecheck, lint, 158 tests, production build and runtime audit with zero findings pass.
- Compose is deployed with loopback-only web exposure; non-root PostgreSQL, Redis, web and worker services; dropped capabilities; no-new-privileges; memory/CPU/PID limits; rotating logs; explicit health checks; and the shared `expojobcrawler-internal` network.
- Persistent dataset `apps/docker/expoxr/jobcrawler-nominatim` has zstd compression, atime disabled and a 180 GB refquota. The pinned Nominatim 5.3.2 DACH import is complete and daily replication updates are configured.
- DACH forward geocoding passes for Germany, Austria and Switzerland. The cached application health endpoint reports database, Redis and Nominatim ready.
- Snapshot `apps/docker/expoxr/jobcrawler-nominatim@auto-2026-08-16_17-14` is replicated to USB; replication task 2 is enabled and finished. JobCrawler has a verified post-deploy dump and `post-design-deploy-2026-08-16` snapshot.
- Live search, SSE, BullMQ queues, Overpass primary/fallback routing, company discovery, bounded website crawling and result persistence pass in production. The controlled Kempten flow persisted 99 companies and 41 sourced jobs.
- Production Playwright covers 320/390/768/1024/1440, light/dark/system, keyboard, reduced motion, 200% zoom and axe with 12 passing checks.
- The 30-minute production observation held API 200, all five services healthy, zero restarts/OOM events and stable resource use. Controlled database/cache/web/worker restarts preserved all counts and the completed 41-result search.
