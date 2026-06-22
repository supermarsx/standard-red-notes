#!/bin/bash

set -euo pipefail

# Realtime WebSocket push gateway. Runs in-container as a supervisord program
# (folded in from the former standalone `websocket-gateway` compose service).
#
# Dedicated PORT: the gateway reads $PORT, but $PORT is a generic name other
# server processes / the platform may set. Hardcode 3106 here so it can never be
# clobbered by an inherited PORT value.
export PORT=3106

# The gateway only needs Redis to be reachable before it boots (the SQS consumer
# self-retries, and its token endpoint has no startup dependency). Wait for the
# cache the same way the other server programs wait for their peers.
sh supervisor/wait-for.sh "${REDIS_HOST:-cache}" "${REDIS_PORT:-6379}"

# `yarn node` loads the workspace's Yarn PnP loader so the ESM entrypoint can
# resolve its dependencies (ws, ioredis, jsonwebtoken, @aws-sdk/client-sqs),
# which are NOT present as a node_modules tree under the PnP linker.
exec yarn node dist/index.js
