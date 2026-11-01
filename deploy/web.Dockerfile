# syntax=docker/dockerfile:1

FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/node-forge ./vendor/node-forge
COPY vendor/braces ./vendor/braces
RUN npm ci --ignore-scripts

COPY app.json tsconfig.json ./
COPY App.tsx .
COPY assets ./assets
COPY src ./src
COPY public ./public
COPY scripts/stamp-pwa-build.mjs ./scripts/stamp-pwa-build.mjs
COPY deploy/render-security-headers.mjs deploy/security-headers.conf ./deploy/
ARG REWIND_DISPLAY_CURRENT_VERSION=false
ARG REWIND_CURRENT_VERSION=local
RUN EXPO_PUBLIC_DISPLAY_CURRENT_VERSION="$REWIND_DISPLAY_CURRENT_VERSION" \
    EXPO_PUBLIC_CURRENT_VERSION="$REWIND_CURRENT_VERSION" \
    EXPO_PUBLIC_LOCAL_BASE_URL=/api npm run build:web \
  && node deploy/render-security-headers.mjs dist deploy/security-headers.conf /app/security-headers.conf

FROM nginx:1.31.8-alpine@sha256:785835ea65db4bba6f021acc0f3be91b0fef76a53fe41f8588c6698d2aed0606 AS runtime

RUN apk upgrade --no-cache
RUN sed -i -E 's#^pid[[:space:]]+[^;]+;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
  && grep -q '^pid /tmp/nginx.pid;' /etc/nginx/nginx.conf

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/security-headers.conf /etc/nginx/security-headers.conf
COPY --chmod=755 deploy/40-security-headers.sh /docker-entrypoint.d/40-security-headers.sh
COPY --from=build /app/dist /usr/share/nginx/html

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
