# syntax=docker/dockerfile:1

FROM node:22.13.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.server.json ./
COPY server ./server
RUN npm run server:build

FROM node:22.13.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    REWIND_HOST=0.0.0.0 \
    REWIND_PORT=8787 \
    REWIND_DATA_DIR=/var/lib/rewind \
    REWIND_FFMPEG_BIN=ffmpeg

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 rewind \
  && useradd --system --uid 10001 --gid rewind --home-dir /nonexistent \
       --shell /usr/sbin/nologin rewind \
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
