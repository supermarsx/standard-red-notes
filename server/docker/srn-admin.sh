#!/bin/sh
# srn-admin — in-container server administration CLI for Standard Red Notes.
#
# Drives the auth package's own use-cases/repositories (users, roles, RBAC
# groups, per-user flags, storage limits, bans, MFA reset, quotas, webhooks,
# audit log, registration gate) against the live database — no HTTP, no admin
# session — plus container-local diagnostics (status / logs / config) that run
# without booting the DI container at all.
#
# Usage (from the host):
#   docker compose exec server srn-admin <command> [args]
#   docker compose exec server srn-admin help [command]
#
# The bin lives under Yarn PnP, so it must run through `yarn node` (which
# activates the PnP resolver). REDIS_URL is derived the same way the
# entrypoint derives it for the running services when it is not already set.
set -e

cd /opt/server/packages/auth

if [ -z "${REDIS_URL:-}" ] && [ -n "${REDIS_HOST:-}" ]; then
  REDIS_URL="redis://$REDIS_HOST"
  export REDIS_URL
fi

exec yarn node dist/bin/srn_admin.js "$@"
