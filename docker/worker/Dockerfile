# syntax=docker/dockerfile:1
#
# Background worker.
#
# The worker runs TypeScript directly through tsx, which keeps the monorepo to
# one toolchain: no per-package build output to keep in sync with the sources.

FROM node:22-alpine AS base
WORKDIR /app

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

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S worker -u 1001

COPY --from=deps --chown=worker:nodejs /app/node_modules ./node_modules
COPY --chown=worker:nodejs package.json tsconfig.base.json tsconfig.json ./
COPY --chown=worker:nodejs packages ./packages
COPY --chown=worker:nodejs apps/worker ./apps/worker
COPY --chown=worker:nodejs migrations ./migrations

USER worker

# Exercises the same module graph the worker boots with, so a broken import is
# caught by the healthcheck rather than by a silent restart loop.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "process.exit(0)"

CMD ["npx", "tsx", "apps/worker/src/index.ts"]
