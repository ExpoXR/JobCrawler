# syntax=docker/dockerfile:1
#
# PostgreSQL with both PostGIS and pgvector.
#
# No official image ships both: postgis/postgis has PostGIS, pgvector/pgvector
# has vector. The PostGIS image is Debian-based with the PGDG apt repository
# already configured, so pgvector installs from the same source Postgres does.

FROM postgis/postgis:16-3.4

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-16-pgvector \
  && rm -rf /var/lib/apt/lists/*
