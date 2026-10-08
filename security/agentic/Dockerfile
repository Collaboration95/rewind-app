# Reuse the repository's pinned Debian Node base; Vigolium needs a glibc runtime.
FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS dependencies
WORKDIR /build
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/scan
# Copy only the scanner, harness and synthetic target. No application code or source maps.
COPY --from=dependencies /build/node_modules/@vigolium ./node_modules/@vigolium
COPY scripts/run-vigolium-agentic.mjs scripts/vigolium-provider.mjs scripts/vigolium-fixture.mjs scripts/vigolium-access.mjs ./scripts/
COPY scripts/check-vigolium-isolation.mjs ./scripts/
ENV REWIND_AGENT_REPORT_DIR=/reports HOME=/tmp
USER 1000:1000
ENTRYPOINT ["node", "scripts/run-vigolium-agentic.mjs"]
CMD ["--verify", "--fixture"]
