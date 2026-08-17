# syntax=docker/dockerfile:1
#
# Next.js web application.
#
# Multi-stage: dependencies are installed once with the workspace manifests
# only, so a source-only change does not invalidate the npm layer. The runtime
# image drops to a non-root user and carries no build tooling.

FROM node:22-alpine AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# --- Dependencies ----------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/crawler/package.json packages/crawler/
COPY packages/database/package.json packages/database/
COPY packages/matching/package.json packages/matching/
COPY packages/providers/package.json packages/providers/
COPY packages/queue/package.json packages/queue/
COPY packages/search/package.json packages/search/
COPY packages/shared/package.json packages/shared/
RUN npm ci --no-audit --no-fund

# --- Build -----------------------------------------------------------------
FROM base AS build
ARG NEXT_PUBLIC_MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
ARG PUBLIC_ROBOTS_NOINDEX=true
ENV NEXT_PUBLIC_MAP_TILE_URL=$NEXT_PUBLIC_MAP_TILE_URL
ENV PUBLIC_ROBOTS_NOINDEX=$PUBLIC_ROBOTS_NOINDEX
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build --workspace=@ejc/web

# --- Runtime ---------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs \
  && adduser -S nextjs -u 1001 \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx

# `output: standalone` emits a self-contained server with only the modules the
# app actually imports.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/migrations ./migrations

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
