# syntax=docker/dockerfile:1

FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS build

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
ARG REWIND_DISPLAY_CURRENT_VERSION=false
ARG REWIND_CURRENT_VERSION=local
RUN EXPO_PUBLIC_DISPLAY_CURRENT_VERSION="$REWIND_DISPLAY_CURRENT_VERSION" \
    EXPO_PUBLIC_CURRENT_VERSION="$REWIND_CURRENT_VERSION" \
    EXPO_PUBLIC_LOCAL_BASE_URL=/api npm run build:web

FROM nginx:1.31.8-alpine@sha256:1ef7ca94d7879df82421428ce13bd1eaa412404953859cf7a5b6512c25e67a60 AS runtime

RUN apk upgrade --no-cache
RUN sed -i -E 's#^pid[[:space:]]+[^;]+;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
  && grep -q '^pid /tmp/nginx.pid;' /etc/nginx/nginx.conf

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
