# syntax=docker/dockerfile:1.7

# =============================================================================
# BUILD STAGE — carries the C/C++ toolchain (g++/make/python3) needed to compile
# native node addons during `yarn install` and to build the TS workspace. NONE
# of these compilers ship in the runtime image below, shrinking the attack
# surface of the network-facing container (no in-container compiler for an
# attacker to abuse).
# =============================================================================
FROM node:24-alpine AS build

ENV NODE_ENV=production

RUN apk add --update --no-cache \
  bash \
  g++ \
  make \
  py3-pip \
  python3

RUN npm install -g corepack@latest && corepack enable

WORKDIR /opt/server

# --- Dependency layer ---------------------------------------------------------
# Copy ONLY what Yarn (PnP) needs to resolve + install: the lockfile, Yarn config
# + releases/plugins, the PnP map, and EVERY package's manifest. Isolating this
# means a source-only change reuses the cached install layer.
COPY .yarnrc.yml yarn.lock .pnp.cjs .pnp.loader.mjs ./
COPY .yarn/ ./.yarn/
COPY package.json ./
COPY packages/analytics/package.json packages/analytics/
COPY packages/api-gateway/package.json packages/api-gateway/
COPY packages/auth/package.json packages/auth/
COPY packages/common/package.json packages/common/
COPY packages/domain-core/package.json packages/domain-core/
COPY packages/domain-events/package.json packages/domain-events/
COPY packages/domain-events-infra/package.json packages/domain-events-infra/
COPY packages/files/package.json packages/files/
COPY packages/grpc/package.json packages/grpc/
COPY packages/home-server/package.json packages/home-server/
COPY packages/predicates/package.json packages/predicates/
COPY packages/revisions/package.json packages/revisions/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/security/package.json packages/security/
COPY packages/settings/package.json packages/settings/
COPY packages/sncrypto-node/package.json packages/sncrypto-node/
COPY packages/syncing-server/package.json packages/syncing-server/
COPY packages/time/package.json packages/time/
COPY packages/websocket-gateway/package.json packages/websocket-gateway/
COPY packages/websockets/package.json packages/websockets/

RUN yarn install --immutable

# --- Source + build -----------------------------------------------------------
COPY . .

RUN CI=true yarn build

# =============================================================================
# RUNTIME STAGE — no compiler toolchain. Carries node + supervisord (its python
# runtime) + the few CLI tools the entrypoint / healthcheck need, plus the fully
# built, PnP-installed workspace copied from the build stage. The native addons
# compiled in the build stage (under .yarn/unplugged) are ABI-compatible because
# both stages share the same node:24-alpine base. Runs as an unprivileged user.
# =============================================================================
FROM node:24-alpine AS runtime

ENV NODE_ENV=production

RUN apk add --update --no-cache \
  bash \
  curl \
  netcat-openbsd \
  openssl \
  py3-pip \
  python3 \
  && pip install --no-cache-dir --upgrade --break-system-packages supervisor

RUN npm install -g corepack@latest && corepack enable

WORKDIR /opt/server

# Supervisor config + entrypoint (rarely change).
COPY docker/supervisord.conf /etc/supervisord.conf
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY docker/srn-admin.sh /usr/local/bin/srn-admin

# The fully built workspace (sources, per-package dist, .yarn cache + unplugged
# native addons, the PnP map). PnP loads packages from .yarn at runtime, so the
# whole tree comes across from the build stage rather than re-installing.
COPY --from=build /opt/server /opt/server

# Normalize line endings (a CRLF checkout leaves `#!/bin/bash\r`), create the
# writable runtime dirs, and create + own everything as the unprivileged `srn`
# user. All service ports are >1024 so no CAP_NET_BIND_SERVICE is needed.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh /usr/local/bin/srn-admin /etc/supervisord.conf \
  && find /opt/server -path '*/supervisor/*.sh' -exec sed -i 's/\r$//' {} + \
  && find /opt/server/docker -name '*.sh' -exec sed -i 's/\r$//' {} + \
  && mkdir -p /var/lib/server/logs /opt/shared/uploads \
  && chmod +x /usr/local/bin/docker-entrypoint.sh \
  && addgroup -g 10001 -S srn \
  && adduser -u 10001 -S srn -G srn \
  && chown -R srn:srn /opt/server /var/lib/server/logs /opt/shared/uploads

USER srn:srn

EXPOSE 3000 3104

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=10 \
  CMD curl -fsS http://localhost:3000/healthcheck >/dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
