#!/bin/sh
set -eu
# Private, stateless instance: never ship the upstream placeholder secret.
SEARXNG_SECRET="$(/usr/local/searxng/.venv/bin/python -c 'import secrets; print(secrets.token_hex(32))')"
export SEARXNG_SECRET
exec /usr/local/searxng/entrypoint.sh "$@"
