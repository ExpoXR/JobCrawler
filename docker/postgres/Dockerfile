# syntax=docker/dockerfile:1
#
# PostgreSQL with both PostGIS and pgvector.
#
# The live volume was created with PostgreSQL 16.15, PostGIS 3.4.3 and
# pgvector 0.8.6. Keep the rebuilt image at those versions: a database engine
# or extension downgrade is not a valid deployment path for an existing data
# directory.

FROM postgis/postgis@sha256:01a6a70e41e6c4467c8f55f6063555ed72db2d6662cd0d571040d42eadaeb6f6

ENV PG_VERSION=16.15-1.pgdg11+2

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      postgresql-16=16.15-1.pgdg11+2 \
      postgresql-client-16=16.15-1.pgdg11+2 \
      postgresql-16-pgvector=0.8.6-1.pgdg11+1 \
  && postgres --version | grep -F '16.15' \
  && test "$(dpkg-query -W -f='${Version}' postgresql-16-pgvector)" = '0.8.6-1.pgdg11+1' \
  && rm -rf /var/lib/apt/lists/*
