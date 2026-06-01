# syntax=docker/dockerfile:1.7

FROM node:20.10.0-alpine

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

WORKDIR /opt/server

COPY docker/supervisord.conf /etc/supervisord.conf
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY . .

RUN corepack enable \
  && yarn install --immutable \
  && CI=true yarn build \
  && mkdir -p /var/lib/server/logs /opt/shared/uploads \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000 3104

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=10 \
  CMD curl -fsS http://localhost:3000/healthcheck >/dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
