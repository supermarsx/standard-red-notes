FROM node:26.5.0-alpine3.23 AS builder

# Install dependencies for building native libraries
RUN apk add --no-cache git openssh-client python3 alpine-sdk \
  && npm install --global corepack@0.35.0 \
  && corepack enable

WORKDIR /workspace

# docker-build plugin copies everything needed for `yarn install` to `manifests` folder.
COPY manifests ./

RUN yarn install --immutable

FROM node:26.5.0-alpine3.23

RUN apk add --no-cache curl \
  && npm install --global corepack@0.35.0 \
  && corepack enable

WORKDIR /workspace

# Copy the installed dependencies from the previous stage.
COPY --from=builder /workspace ./

# docker-build plugin runs `yarn pack` in all workspace dependencies and copies them to `packs` folder.
COPY packs ./

CMD [ "yarn", "start:test-server" ]
