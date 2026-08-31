# syntax=docker/dockerfile:1
#
# PostgreSQL with both PostGIS and pgvector.
#
# The live volume was created with PostgreSQL 16.15, PostGIS 3.4.3 and
# pgvector 0.8.6. Keep the rebuilt image at those versions: a database engine
# or extension downgrade is not a valid deployment path for an existing data
# directory.

FROM postgis/postgis@sha256:624f5195b91d424dbebf018890148cc0e5a3e80db5467da8b53cc2ed2ce49216

ENV PG_VERSION=16.15-1.pgdg11+2

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      postgresql-16=16.15-1.pgdg11+2 \
      postgresql-client-16=16.15-1.pgdg11+2 \
      postgresql-16-pgvector=0.8.6-1.pgdg11+1 \
  && postgres --version | grep -F '16.15' \
  && test "$(dpkg-query -W -f='${Version}' postgresql-16-pgvector)" = '0.8.6-1.pgdg11+1' \
  && rm -rf /var/lib/apt/lists/*
