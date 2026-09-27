# syntax=docker/dockerfile:1

FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY app.json tsconfig.json ./
COPY App.tsx .
COPY src ./src
COPY public ./public
RUN EXPO_PUBLIC_LOCAL_BASE_URL=/api npm run build:web

FROM nginx:1.31.1-alpine@sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a AS runtime

RUN apk upgrade --no-cache
RUN sed -i -E 's#^pid[[:space:]]+[^;]+;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
  && grep -q '^pid /tmp/nginx.pid;' /etc/nginx/nginx.conf

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
