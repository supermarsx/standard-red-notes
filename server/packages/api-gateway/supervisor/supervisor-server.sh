#!/bin/bash

set -euo pipefail

sh supervisor/wait-for.sh localhost $AUTH_SERVER_PORT
sh supervisor/wait-for.sh localhost $FILES_SERVER_PORT
sh supervisor/wait-for.sh localhost $REVISIONS_SERVER_PORT
sh supervisor/wait-for.sh localhost $SYNCING_SERVER_PORT

# Standard Red Notes: decide the internal transport HERE, not in
# docker-entrypoint.sh. `grpc` is what binds the durable sync command port and
# so what makes the gateway advertise the socket SYNC_ITEMS lane; it used to
# require hand-editing SERVICE_PROXY_TYPE into .env, and nothing said so.
#
# It cannot be defaulted in the entrypoint: GRPCServiceProxy has no HTTP
# fallback (validateSession retries UNAVAILABLE three times and then throws;
# items/sync rejects), so `grpc` aimed at a listener that is not answering is a
# dead API. The entrypoint runs before supervisord starts anything, so no gRPC
# listener exists there to probe. Here, after the four waits above, it does.
#
# An explicit API_GATEWAY_SERVICE_PROXY_TYPE from the operator's .env always
# wins. Otherwise gRPC is taken only when both halves are co-located, both dial
# targets exist, the durable-command secret is usable, and both gRPC listeners
# actually answer; anything else keeps the HTTP proxies, exactly as before.
#
# The export is inherited by the node process below and dotenv never overrides
# an inherited variable, so api-gateway/.env is not rewritten and no other
# supervisord program sees this.
if [ -r /usr/local/bin/internal-grpc-lane-env.sh ]; then
  # shellcheck disable=SC1091
  . /usr/local/bin/internal-grpc-lane-env.sh
  srn_resolve_service_proxy_type
  echo "# api-gateway service proxy: ${SERVICE_PROXY_TYPE:-http} (${SRN_SERVICE_PROXY_TYPE_DECISION})"
fi

exec yarn node docker/entrypoint-server.js
