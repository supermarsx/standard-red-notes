# syntax=docker/dockerfile:1.7

FROM node:16.20.2-bullseye-slim AS build

WORKDIR /opt/standard-red-notes/app

ENV CI=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN corepack enable \
  && yarn install --immutable \
  && yarn build:web

FROM nginx:1.27-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /opt/standard-red-notes/app/packages/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://localhost/health >/dev/null || exit 1
