# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build

WORKDIR /opt/standard-red-notes

RUN npm install -g corepack@latest && corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
COPY mcp/package.json ./mcp/
COPY openclaw/package.json ./openclaw/
COPY websocket-gateway/package.json ./websocket-gateway/

RUN yarn install --immutable

COPY websocket-gateway/tsconfig.json ./websocket-gateway/
COPY websocket-gateway/src ./websocket-gateway/src

# Plain Node service: a normal tsc build to dist/ (no esbuild bundling).
RUN yarn workspace @standard-red-notes/websocket-gateway build

FROM node:22-alpine

WORKDIR /opt/standard-red-notes

ENV NODE_ENV=production \
    PORT=3106 \
    REDIS_HOST=redis \
    REDIS_PORT=6379

# Runtime deps (ws, ioredis, jsonwebtoken) are hoisted to the root node_modules
# by the yarn node-modules linker, so shipping that plus the compiled dist/ is
# enough (no per-package node_modules exists).
COPY --from=build /opt/standard-red-notes/node_modules ./node_modules
COPY --from=build /opt/standard-red-notes/websocket-gateway/package.json ./websocket-gateway/package.json
COPY --from=build /opt/standard-red-notes/websocket-gateway/dist ./websocket-gateway/dist

EXPOSE 3106

ENTRYPOINT ["node", "websocket-gateway/dist/index.js"]
