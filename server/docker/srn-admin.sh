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
# The bin lives under Yarn PnP, so Node launches the workspace's checked-in Yarn
# CLI and its `node` subcommand activates both the PnP resolver and ESM loader.
# In the all-in-one image the generated runtime configuration lives in the
# home-server package's .env; using that package as cwd lets dotenv parse it as
# data when the CLI boots (the wrapper never sources/evaluates it as shell).
# Multi-container deployments receive configuration directly from Compose and
# fall back to the auth package cwd. REDIS_URL is derived the same way the
# entrypoint derives it for the running services when it is not already set.
set -e

server_root="${SRN_SERVER_ROOT:-/opt/server}"
auth_dir="${server_root}/packages/auth"
home_server_dir="${server_root}/packages/home-server"
node_bin="${SRN_ADMIN_NODE_BIN:-node}"
yarn_cli="${SRN_ADMIN_YARN_CLI:-${server_root}/.yarn/releases/yarn-4.17.1.cjs}"

if [ -f "${home_server_dir}/.env" ]; then
  cd "${home_server_dir}"
else
  cd "${auth_dir}"
fi

if [ -z "${REDIS_URL:-}" ] && [ -n "${REDIS_HOST:-}" ]; then
  REDIS_URL="redis://$REDIS_HOST"
  export REDIS_URL
fi

exec "${node_bin}" "${yarn_cli}" node "${auth_dir}/dist/bin/srn_admin.js" "$@"
