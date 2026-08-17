# syntax=docker/dockerfile:1
#
# PostgreSQL with both PostGIS and pgvector.
#
# The live volume was created with PostgreSQL 16.15, PostGIS 3.4.3 and
# pgvector 0.8.6. Keep the rebuilt image at those versions: a database engine
# or extension downgrade is not a valid deployment path for an existing data
# directory.

FROM postgis/postgis@sha256:44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5

ENV PG_VERSION=16.15-1.pgdg11+2

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      postgresql-16=16.15-1.pgdg11+2 \
      postgresql-client-16=16.15-1.pgdg11+2 \
      postgresql-16-pgvector=0.8.6-1.pgdg11+1 \
  && postgres --version | grep -F '16.15' \
  && test "$(dpkg-query -W -f='${Version}' postgresql-16-pgvector)" = '0.8.6-1.pgdg11+1' \
  && rm -rf /var/lib/apt/lists/*
