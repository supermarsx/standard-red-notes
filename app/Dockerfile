# syntax=docker/dockerfile:1.7

ARG SRN_DEPLOY_REVISION=""
ARG SRN_DEPLOY_VERSION=""

FROM alpine:3.23 AS deployment-identity

ARG SRN_DEPLOY_REVISION
ARG SRN_DEPLOY_VERSION
# The public marker at /.well-known/srn-deployment.json exists to answer exactly
# one question during an incident: WHICH COMMIT IS LIVE? An empty string answers
# nothing and is indistinguishable from a serialization bug, so an unstamped
# build records the explicit `unstamped` sentinel instead of "". Same fail-closed
# contract as the CSP inline-script hash: the value is either real or
# unmistakably absent, and never silently blank.
#
# The build contexts deliberately exclude .git (see .dockerignore), so the
# revision CANNOT be derived here and MUST be passed in — scripts/setup.sh and
# CI do this, or pass `--build-arg SRN_DEPLOY_REVISION=$(git rev-parse HEAD)`.
# When a revision IS supplied but no version is, the version is derived from the
# revision, so the two images of one build always agree (mirrors setup.sh).
#
# Alpine's /bin/sh is busybox ash, whose default pipeline status is the LAST
# command's — so a failing `printf` feeding `cut` below would be swallowed and
# the marker would be stamped from truncated input. pipefail makes the whole
# pipeline fail-closed, matching the rest of this stage (hadolint DL4006).
SHELL ["/bin/ash", "-o", "pipefail", "-c"]
RUN set -eu; \
  revision="${SRN_DEPLOY_REVISION}"; \
  version="${SRN_DEPLOY_VERSION}"; \
  [ -n "${revision}" ] || revision='unstamped'; \
  if [ "${revision}" != 'unstamped' ]; then \
    [ "${#revision}" -eq 40 ] && case "${revision}" in *[!0-9a-f]*) false ;; *) true ;; esac \
      || { echo 'SRN_DEPLOY_REVISION must be unset or exactly 40 lowercase hexadecimal characters.' >&2; exit 64; }; \
  fi; \
  if [ -z "${version}" ]; then \
    if [ "${revision}" = 'unstamped' ]; then \
      version='unstamped'; \
    else \
      version="src-$(printf '%s' "${revision}" | cut -c1-12)"; \
    fi; \
  fi; \
  [ "${#version}" -le 128 ] && case "${version}" in [0-9A-Za-z]*) true ;; *) false ;; esac \
    && case "${version}" in *[!0-9A-Za-z._+-]*) false ;; *) true ;; esac \
    || { echo 'SRN_DEPLOY_VERSION must be unset or a 1-128 character safe ASCII version token.' >&2; exit 64; }; \
  install -d -m 0555 /srn-deployment; \
  printf '{"revision":"%s","version":"%s"}\n' "${revision}" "${version}" > /srn-deployment/deployment.json; \
  chmod 0444 /srn-deployment/deployment.json

FROM node:26.5.0-bookworm-slim AS build

WORKDIR /opt/standard-red-notes/app

ENV CI=true
# Suppress node-runtime DeprecationWarnings (util._extend / fs.Stats) emitted by
# transitive build-time dependencies — they're not actionable from this repo and
# only add noise to the build log. Affects the build stage only (final image is nginx).
ENV NODE_OPTIONS=--no-deprecation

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global corepack@0.35.0 \
  && corepack enable

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
# deps, whose native builds aren't needed for the web image; focusing skips them.
RUN --mount=type=cache,target=/opt/standard-red-notes/app/.yarn/cache,sharing=locked \
  yarn workspaces focus @standardnotes/web

# --- Source + build layer -----------------------------------------------------
# Now bring in the source and build. Only this layer rebuilds on a code change;
# the dependency layer above stays cached.
COPY . .
# Persist the webpack filesystem cache (and any other node_modules/.cache tool
# state) across image builds via a BuildKit cache mount. `COPY . .` invalidates
# this layer on ANY source change, so without the mount every rebuild ran webpack
# from a COLD cache — the dominant recurring cost. With it, webpack recompiles
# only the changed modules. Cache location is pinned in web.webpack.config.js
# (cacheDirectory) to match this mount target.
RUN --mount=type=cache,target=/opt/standard-red-notes/app/node_modules/.cache \
  yarn build:web

# Hardening: run the runtime image as a NON-ROOT user. The unprivileged nginx
# image is a drop-in for nginx:alpine that runs the master process as the
# unprivileged `nginx` user (uid 101) and listens on 8080 (a port >1024, so no
# CAP_NET_BIND_SERVICE is required). Its /docker-entrypoint.d/ runs the same
# templating/entrypoint scripts as the stock image, so the OCR drop-in below
# still executes at container start.
FROM nginxinc/nginx-unprivileged:1.30.3-alpine3.23

ARG SRN_DEPLOY_REVISION
ARG SRN_DEPLOY_VERSION
COPY --from=deployment-identity --chown=0:0 --chmod=0555 /srn-deployment /usr/share/srn-deployment
COPY --from=deployment-identity --chown=0:0 --chmod=0444 /srn-deployment/deployment.json /usr/share/srn-deployment/deployment.json
LABEL org.opencontainers.image.revision="${SRN_DEPLOY_REVISION}"
LABEL org.opencontainers.image.version="${SRN_DEPLOY_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/supermarsx/standard-red-notes"

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
# The entrypoint runs as the unprivileged `nginx` user and rewrites BOTH the
# served index.html (OCR/SYNC templating) AND default.conf (self-healing CSP
# inline-script hash). COPY lands default.conf as root:root, so hand it (and the
# html) to nginx; conf.d itself is already nginx-writable in the base image, so
# sed -i can write its temp file there.
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh \
  && chown -R nginx:nginx /usr/share/nginx/html \
  && chown nginx:nginx /etc/nginx/conf.d/default.conf
USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
