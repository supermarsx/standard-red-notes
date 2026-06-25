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

RUN npm install -g corepack@latest && corepack enable

# --- Dependency layer ---------------------------------------------------------
# Copy ONLY what Yarn needs to resolve + install the workspace graph: every
# workspace's package.json, the lockfile, and the Yarn config/release. This keeps
# the (slow) install below in its own cache layer so a change to application
# SOURCE no longer re-downloads/relinks the whole dependency closure — the layer
# is reused until a manifest or the lockfile actually changes.
COPY package.json yarn.lock .yarnrc.yml babel.config.js ./
COPY .yarn/ .yarn/
COPY packages/api/package.json packages/api/
COPY packages/clipper/package.json packages/clipper/
COPY packages/desktop/package.json packages/desktop/
COPY packages/desktop/app/package.json packages/desktop/app/
COPY packages/encryption/package.json packages/encryption/
COPY packages/features/package.json packages/features/
COPY packages/filepicker/package.json packages/filepicker/
COPY packages/files/package.json packages/files/
COPY packages/icons/package.json packages/icons/
COPY packages/mobile/package.json packages/mobile/
COPY packages/models/package.json packages/models/
COPY packages/releases/package.json packages/releases/
COPY packages/responses/package.json packages/responses/
COPY packages/services/package.json packages/services/
COPY packages/sncrypto-common/package.json packages/sncrypto-common/
COPY packages/sncrypto-web/package.json packages/sncrypto-web/
COPY packages/snjs/package.json packages/snjs/
COPY packages/styles/package.json packages/styles/
COPY packages/toast/package.json packages/toast/
COPY packages/ui-services/package.json packages/ui-services/
COPY packages/utils/package.json packages/utils/
COPY packages/web/package.json packages/web/

# Install only the web workspace's dependency closure. A full `yarn install` also
# packs the desktop (`decrypt` → node-sass) and mobile (react-native forks) git
# deps, whose native builds don't compile on Node 24; focusing skips them.
RUN yarn workspaces focus @standardnotes/web

# --- Source + build layer -----------------------------------------------------
# Now bring in the source and build. Only this layer rebuilds on a code change;
# the dependency layer above stays cached.
COPY . .
RUN yarn build:web

# Hardening: run the runtime image as a NON-ROOT user. The unprivileged nginx
# image is a drop-in for nginx:alpine that runs the master process as the
# unprivileged `nginx` user (uid 101) and listens on 8080 (a port >1024, so no
# CAP_NET_BIND_SERVICE is required). Its /docker-entrypoint.d/ runs the same
# templating/entrypoint scripts as the stock image, so the OCR drop-in below
# still executes at container start.
FROM nginxinc/nginx-unprivileged:1.27-alpine

# nginx.conf below listens on 8080 (the unprivileged default) instead of :80 so
# the worker can bind without root. Compose maps the host port to 8080.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /opt/standard-red-notes/app/packages/web/dist /usr/share/nginx/html

# Runtime config templating (e.g. OCR_ENABLED) for the static bundle. Rewrites
# the window.* globals in index.html from env at container start, then hands off
# to the stock nginx entrypoint so operators can flip flags without a rebuild.
# The unprivileged image's entrypoint runs these as the `nginx` user, so the
# script and index.html must be writable by it (handled while still root below).
USER root
COPY docker/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh \
  && chown -R nginx:nginx /usr/share/nginx/html
USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
