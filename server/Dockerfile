# syntax=docker/dockerfile:1.7

FROM node:24-alpine

ENV NODE_ENV=production

RUN apk add --update --no-cache \
  bash \
  curl \
  g++ \
  make \
  netcat-openbsd \
  openssl \
  py3-pip \
  python3 \
  && pip install --no-cache-dir --upgrade --break-system-packages supervisor

RUN npm install -g corepack@latest && corepack enable

WORKDIR /opt/server

# Supervisor config + entrypoint (rarely change) — copy early so they stay cached.
COPY docker/supervisord.conf /etc/supervisord.conf
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# --- Dependency layer ---------------------------------------------------------
# Copy ONLY what Yarn (PnP) needs to resolve + install the workspace: the
# lockfile, Yarn config + releases/plugins, the PnP map, and EVERY package's
# manifest. `yarn install` downloads and populates .yarn/cache into THIS image
# layer (PnP loads packages from it at runtime), so isolating it here means a
# source-only change no longer re-runs the whole install — the layer is reused
# until a manifest or the lockfile changes.
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
# Only this layer rebuilds on a code change; the dependency layer above stays
# cached. (.yarn/cache populated by the install above is preserved — it is not
# part of the build context, so this COPY does not remove it.)
COPY . .

# Normalize line endings: a CRLF checkout (Windows) leaves `#!/bin/bash\r`, which the
# Linux kernel reads as interpreter "/bin/bash\r" → "no such file or directory" at exec.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh /etc/supervisord.conf \
  && find /opt/server -path '*/supervisor/*.sh' -exec sed -i 's/\r$//' {} + \
  && find /opt/server/docker -name '*.sh' -exec sed -i 's/\r$//' {} +

RUN CI=true yarn build \
  && mkdir -p /var/lib/server/logs /opt/shared/uploads \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000 3104

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=10 \
  CMD curl -fsS http://localhost:3000/healthcheck >/dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
