# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build

WORKDIR /opt/standard-red-notes

RUN npm install -g corepack@latest && corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
COPY mcp/package.json ./mcp/
COPY openclaw/package.json ./openclaw/

# esbuild needs its native binary (enableScripts is set in .yarnrc.yml).
RUN yarn install --immutable

COPY mcp/tsconfig.json mcp/esbuild.config.mjs ./mcp/
COPY mcp/src ./mcp/src

# Bundle to a single self-contained CJS file (snjs + crypto inlined, browser
# globals shimmed via the esbuild banner / libsodium sumo alias).
RUN yarn workspace @standard-red-notes/mcp build

FROM node:22-alpine

WORKDIR /opt/standard-red-notes

ENV NODE_ENV=production \
    STANDARD_RED_NOTES_SERVER_URL=http://server:3000 \
    STANDARD_RED_NOTES_DATA_DIR=/var/lib/standard-red-notes-mcp

# The build output is fully bundled — no node_modules needed at runtime.
COPY --from=build /opt/standard-red-notes/mcp/dist/index.cjs ./mcp/dist/index.cjs

RUN mkdir -p /var/lib/standard-red-notes-mcp
VOLUME ["/var/lib/standard-red-notes-mcp"]

ENTRYPOINT ["node", "mcp/dist/index.cjs"]
