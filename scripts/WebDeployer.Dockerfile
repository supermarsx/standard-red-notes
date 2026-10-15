FROM node:26.5.0-alpine
RUN apk add --no-cache docker-cli docker-cli-compose
COPY deploy-web.mjs /usr/local/bin/deploy-web.mjs
ENTRYPOINT ["node", "/usr/local/bin/deploy-web.mjs"]
