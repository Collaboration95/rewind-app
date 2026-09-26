# syntax=docker/dockerfile:1

FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.server.json ./
COPY server ./server
RUN npm run server:build

FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime

ENV NODE_ENV=production \
    REWIND_HOST=0.0.0.0 \
    REWIND_PORT=8787 \
    REWIND_DATA_DIR=/var/lib/rewind \
    REWIND_FFMPEG_BIN=ffmpeg

RUN apk add --no-cache ca-certificates 'ffmpeg=8.1.2-r0' \
  && rm -rf /usr/local/lib/node_modules /opt/yarn-v* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && addgroup -S -g 10001 rewind \
  && adduser -S -D -H -u 10001 -G rewind rewind \
  && mkdir -p /var/lib/rewind \
  && chown -R rewind:rewind /var/lib/rewind

WORKDIR /app
COPY --from=build --chown=rewind:rewind /app/server/dist ./server/dist
COPY --from=build --chown=rewind:rewind /app/server/migrations ./server/migrations
COPY --from=build --chown=rewind:rewind /app/server/fixtures ./server/fixtures

USER rewind
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Keep runtime-created SQLite, WAL/SHM, and nested media entries inside the
# same private contract that restore.sh enforces: directories 0750, files 0640.
# The exec preserves signals and applies to start, migrate, and reset alike.
ENTRYPOINT ["/bin/sh", "-c", "umask 027; exec node server/dist/cli.js \"$@\"", "rewind-runtime"]
CMD ["start"]
