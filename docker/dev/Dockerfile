# syntax=docker/dockerfile:1
#
# Development toolchain.
#
# The other images in this repo are lean runtime artefacts: they carry no npm,
# no compiler and no test runner. This one is the opposite — it exists so that
# `npm run check`, `npm run migrate` and the test suites can be run without
# installing Node on the host.
#
#   docker compose -f docker-compose.dev.yml run --rm tools npm run check
#
# Never deploy this image. It mounts the working tree read-write and ships the
# full build toolchain.

FROM node:22-alpine

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=development

# git: tooling reads repository state and npm resolves git-backed dependencies.
# python3/make/g++: build dependencies for packages with native addons.
RUN apk add --no-cache git bash curl python3 make g++

# The container runs as the *host* user (see `user:` in docker-compose.dev.yml)
# so that files it writes into the bind-mounted tree are not root-owned. That
# uid has no home directory inside the image, so point everything that wants one
# at a writable path.
ENV HOME=/tmp \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    XDG_CACHE_HOME=/tmp/.cache

WORKDIR /app

# No COPY, no `npm ci` at build time: the working tree is bind-mounted at run
# time, so the image stays valid across every source change. Populate
# node_modules by running `npm ci` through this container once.
CMD ["bash"]
