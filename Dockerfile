# IntraDocs web + worker as one image, built from the workspace.
#
# The build is profile-agnostic on purpose: no APP_URL, no secret and no database URL is
# baked in. Everything that differs between environments arrives as environment variables
# at start, and `readRuntimeConfig` refuses to boot when they are missing or weak -- so an
# image that starts at all is an image that was configured.
#
#   docker build -t intradocs:0.3.0 .
#   docker run --env-file .env.production -p 3000:3000 intradocs:0.3.0
#
# The runtime stage carries no build toolchain, no source and no dev dependencies, and
# runs as an unprivileged user that owns nothing but its own process.

FROM node:24-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /build
COPY . .
# Standalone output: the runtime stage then needs neither node_modules nor pnpm.
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_STANDALONE=1
RUN pnpm --filter @intradocs/web build && pnpm --filter @intradocs/worker build

FROM node:24-bookworm-slim AS runtime
# tini reaps the children `dev.ts --production` starts, so a stopped container leaves no
# orphan worker behind; curl is what the container healthcheck uses.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# Next's standalone bundle already contains the server and the dependencies it traced.
COPY --from=build --chown=node:node /build/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /build/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /build/apps/web/public ./apps/web/public
# The worker is a single bundled file; `docker compose` runs it as its own service.
COPY --from=build --chown=node:node /build/apps/worker/dist/index.js ./apps/worker/dist/index.js
# Migrations travel with the image so a release can apply its own schema.
COPY --from=build --chown=node:node /build/packages/db/migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
