FROM node:26.5.0-alpine

RUN apk add --no-cache curl

ENV NODE_ENV production

RUN npm install -g corepack@0.35.0 && corepack enable

COPY ./ /workspace

WORKDIR /workspace

RUN yarn install --immutable

RUN yarn build

WORKDIR /workspace/packages/auth

ENTRYPOINT [ "/workspace/packages/auth/docker/entrypoint.sh" ]

CMD [ "start-web" ]
