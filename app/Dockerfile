# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /opt/standard-red-notes/app

ENV CI=true
# Suppress node-runtime DeprecationWarnings (util._extend / fs.Stats) emitted by
# transitive build-time dependencies — they're not actionable from this repo and
# only add noise to the build log. Affects the build stage only (final image is nginx).
ENV NODE_OPTIONS=--no-deprecation

# Insurance for any git-sourced dep that still packs via the bundled Yarn 1 (classic):
# its engine pins predate Node 24. A classic ~/.yarnrc disables that check for the nested
# pack process only; Yarn Berry (the outer install) reads .yarnrc.yml and ignores this file.
RUN printf -- '--ignore-engines true\n' > /root/.yarnrc

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY . .

# Install only the web workspace's dependency closure. A full `yarn install` also packs the
# desktop (`decrypt` → node-sass) and mobile (react-native forks) git deps, whose native
# builds don't compile on Node 24; focusing skips them.
RUN npm install -g corepack@latest \
  && corepack enable \
  && yarn workspaces focus @standardnotes/web \
  && yarn build:web

FROM nginx:1.27-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /opt/standard-red-notes/app/packages/web/dist /usr/share/nginx/html

# Runtime config templating (e.g. OCR_ENABLED) for the static bundle. Rewrites
# the window.* globals in index.html from env at container start, then hands off
# to the stock nginx entrypoint so operators can flip flags without a rebuild.
COPY docker/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1/health >/dev/null || exit 1
