# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build

WORKDIR /opt/standard-red-notes

RUN npm install -g corepack@latest && corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
COPY mcp/package.json mcp/tsconfig.json ./mcp/
COPY mcp/src ./mcp/src
COPY openclaw/package.json ./openclaw/

RUN yarn install --immutable \
  && yarn workspace @standard-red-notes/mcp build

FROM node:22-alpine

WORKDIR /opt/standard-red-notes

ENV NODE_ENV=production

COPY --from=build /opt/standard-red-notes/node_modules ./node_modules
COPY --from=build /opt/standard-red-notes/mcp/package.json ./mcp/package.json
COPY --from=build /opt/standard-red-notes/mcp/dist ./mcp/dist

ENTRYPOINT ["node", "mcp/dist/index.js"]
