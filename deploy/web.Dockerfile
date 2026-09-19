# syntax=docker/dockerfile:1

FROM node:22.13.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY app.json tsconfig.json ./
COPY App.tsx .
COPY src ./src
RUN EXPO_PUBLIC_LOCAL_BASE_URL=/api npm run build:web

FROM nginx:1.27-alpine AS runtime

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
