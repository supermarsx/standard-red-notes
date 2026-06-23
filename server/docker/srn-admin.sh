#!/bin/sh
# srn-admin — in-container admin CLI for the Standard Red Notes server.
#
# Drives the auth package's own use-cases/repositories (roles, RBAC groups, MFA
# reset, storage quota) against the live database — no HTTP, no admin session.
#
# Usage (from the host):
#   docker compose exec server srn-admin <command> [args]
#   docker compose exec server srn-admin help
#
# The auth bin is ESM under Yarn PnP, so it must run through `yarn node` (which
# activates the PnP ESM loader). REDIS_URL is derived the same way the
# entrypoint derives it for the running services when it is not already set.
set -e

cd /opt/server/packages/auth

if [ -z "${REDIS_URL:-}" ] && [ -n "${REDIS_HOST:-}" ]; then
  REDIS_URL="redis://$REDIS_HOST"
  export REDIS_URL
fi

exec yarn node dist/bin/srn_admin.js "$@"
