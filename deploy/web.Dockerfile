# syntax=docker/dockerfile:1

FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS build

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
ARG REWIND_BUILD_SHA=local
ARG REWIND_BUILD_BRANCH=local
RUN EXPO_PUBLIC_BUILD_SHA="$REWIND_BUILD_SHA" \
    EXPO_PUBLIC_BUILD_BRANCH="$REWIND_BUILD_BRANCH" \
    EXPO_PUBLIC_LOCAL_BASE_URL=/api npm run build:web

FROM nginx:1.31.6-alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2 AS runtime

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
