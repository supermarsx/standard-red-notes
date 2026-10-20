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

# --- Library source + build layer ---------------------------------------------
# Keep web source out of this layer: a UI-only change must not recompile every
# SDK/library. Copy complete dependency workspaces (including raw-source entry
# points and assets), plus their shared build configuration. The cache contract
# test checks this list against the actual transitive workspace graph.
COPY tsconfig.base.json UILib.tsconfig.json ./
COPY scripts/ scripts/
COPY packages/api/ packages/api/
COPY packages/encryption/ packages/encryption/
COPY packages/features/ packages/features/
COPY packages/filepicker/ packages/filepicker/
COPY packages/files/ packages/files/
COPY packages/icons/ packages/icons/
COPY packages/models/ packages/models/
COPY packages/responses/ packages/responses/
COPY packages/services/ packages/services/
COPY packages/sncrypto-common/ packages/sncrypto-common/
COPY packages/sncrypto-web/ packages/sncrypto-web/
COPY packages/snjs/ packages/snjs/
COPY packages/styles/ packages/styles/
COPY packages/toast/ packages/toast/
COPY packages/ui-services/ packages/ui-services/
COPY packages/utils/ packages/utils/
# Preserve the ordinary topological build and its type checks. Changes to any
# copied library/configuration still invalidate this layer automatically.
# Bound simultaneous TypeScript/library compilers on large CPU hosts.
ARG SRN_BUILD_JOBS=2
RUN node -e 'const n=Number(process.env.SRN_BUILD_JOBS); if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error("SRN_BUILD_JOBS must be an integer from 1 to 64")'
RUN yarn workspaces foreach -pt --jobs "${SRN_BUILD_JOBS}" --topological-dev --verbose -R --from @standardnotes/web --exclude @standardnotes/web run build
# --- Web source + build layer -------------------------------------------------
# Build output/node_modules are excluded by .dockerignore, so this overlay keeps
# the freshly compiled libraries while admitting every current web/build input.
COPY . .
# *** THE WEB BUNDLE IS BUILT COLD, ON PURPOSE. *** This step used to carry
# `--mount=type=cache,target=…/node_modules/.cache`, which kept webpack's
# filesystem cache between image builds and saved about four minutes a rebuild.
# It is gone because an image built that way was caught carrying OLD code: an
# all-in-one image built from a commit that contained a fix shipped the sync
# worker from before the fix (`03e62a95….worker.js` where the same source, built
# cold, gives `5662d1da….worker.js`), while the entry bundle, the deployment
# marker and the readiness route all named the new commit. Webpack reported 6111
# modules restored from the cache in that build.
#
# How the cache came to hold a worker that did not match its sources is NOT
# established, and it has not been reproduced on demand. The leading suspect is
# that a cache mount is keyed by its target path alone, so every build on a
# daemon — of any commit, several at once — read and wrote the one directory.
# That is a suspicion, not a finding. What is established is the outcome, and an
# image that runs old code while every identity check says "current" costs far
# more than a slower build. node_modules is excluded from the build context,
# and the dependency-only pass above never runs the web compiler. Its library
# webpack configurations use no filesystem cache, so this layer contains no
# previous web compilation to restore. There is still no shared cache mount.
#
# Do not put the mount back without a test that builds two different commits
# against one cache and compares every emitted file with a cold build.
# The revision reaches the BUILD, not only the marker. Two things read it there
# (see packages/web/web.webpack.config.js): the bundle compiles it in, so a
# running tab can say which build it is and be told apart from a stale shell;
# and the service worker keys its cache name on it, so the cache and the
# deployment marker name the same release. It was declared for the marker stage
# alone, so the worker fell back to a build timestamp and the bundle carried no
# identity at all. Scoped to this one command — it is not an ENV, so nothing
# else in the stage is invalidated by it — and empty is still a valid build.
ARG SRN_DEPLOY_REVISION
ARG WEBPACK_PARALLELISM=32
ARG WEBPACK_MINIFY_WORKERS=2
RUN SRN_DEPLOY_REVISION="${SRN_DEPLOY_REVISION}" WEBPACK_PARALLELISM="${WEBPACK_PARALLELISM}" WEBPACK_MINIFY_WORKERS="${WEBPACK_MINIFY_WORKERS}" yarn workspace @standardnotes/web build

# Hardening: run the runtime image as a NON-ROOT user. The unprivileged nginx
# image is a drop-in for nginx:alpine that runs the master process as the
# unprivileged `nginx` user (uid 101) and listens on 8080 (a port >1024, so no
# CAP_NET_BIND_SERVICE is required). Its /docker-entrypoint.d/ runs the same
# templating/entrypoint scripts as the stock image, so the OCR drop-in below
# still executes at container start.
FROM nginxinc/nginx-unprivileged:1.30.3-alpine3.23

# COPY --chown owns incoming files, but an existing destination directory can
# retain its base-image owner. Runtime sed -i needs the html directory writable
# too; fix that once in a stable layer before copying the changing bundle.
USER root
RUN chown nginx:nginx /usr/share/nginx/html
USER nginx

# nginx.conf below listens on 8080 (the unprivileged default) instead of :80 so
# the worker can bind without root. Compose maps the host port to 8080.
COPY --chown=nginx:nginx docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /opt/standard-red-notes/app/packages/web/dist /usr/share/nginx/html

# Runtime config templating (e.g. OCR_ENABLED) for the static bundle. Rewrites
# the window.* globals in index.html from env at container start, then hands off
# to the stock nginx entrypoint so operators can flip flags without a rebuild.
# The unprivileged image's entrypoint runs these as the `nginx` user, so the
# index.html and config are owned by nginx at COPY time, avoiding a recursive
# chown layer over every freshly built bundle. The entrypoint itself stays
# root-owned and executable by nginx.
COPY --chmod=0555 docker/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
# The entrypoint runs as the unprivileged `nginx` user and rewrites BOTH the
# served index.html (OCR/SYNC templating) AND default.conf (self-healing CSP
# inline-script hash). conf.d itself is already nginx-writable in the base
# image, so sed -i can write its temp file there.
USER nginx

# Stamp only after all runtime setup/artifact layers: changing identity must
# not invalidate otherwise identical configuration or ownership work.
ARG SRN_DEPLOY_REVISION
ARG SRN_DEPLOY_VERSION
COPY --from=deployment-identity --chown=0:0 --chmod=0555 /srn-deployment /usr/share/srn-deployment
COPY --from=deployment-identity --chown=0:0 --chmod=0444 /srn-deployment/deployment.json /usr/share/srn-deployment/deployment.json
LABEL org.opencontainers.image.revision="${SRN_DEPLOY_REVISION}"
LABEL org.opencontainers.image.version="${SRN_DEPLOY_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/supermarsx/standard-red-notes"

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
