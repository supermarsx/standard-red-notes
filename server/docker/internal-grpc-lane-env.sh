#!/usr/bin/env sh

# =============================================================================
# Standard Red Notes — socket SYNC_ITEMS lane self-configuration.
#
# Two decisions used to be hand-edited into the operator's .env, and nothing
# told anybody they were needed:
#
#   SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET  the HMAC key the api-gateway SIGNS
#       durable sync commands with and the syncing-server VERIFIES them with.
#       `InternalGrpcServiceAuth.ready()` wants >= 32 bytes; below that it reads
#       as "unconfigured", `SyncWebSocketCommandAdapter.ready()` is false with
#       it, and SYNC_ITEMS is withheld from negotiation — clients silently sync
#       over HTTP.
#   SERVICE_PROXY_TYPE                        `grpc` is what binds the durable
#       command port at all. Empty kept the HTTP proxies.
#
# This file is SOURCED (it only defines functions); each caller runs the one it
# needs, because they run at different times:
#
#   docker-entrypoint.sh                 -> srn_prepare_internal_grpc_secret
#   api-gateway/supervisor/
#     supervisor-server.sh               -> srn_resolve_service_proxy_type
#
# Nothing here ever prints a secret value.
# =============================================================================

# Byte length of a value, matching `Buffer.byteLength(value, 'utf8')` — which is
# what InternalGrpcServiceAuth.ready() measures. `${#var}` counts CHARACTERS and
# would over-report a non-ASCII operator-supplied secret as long enough.
srn_byte_length() {
  printf '%s' "${1:-}" | wc -c | tr -d '[:space:]'
}

# Is this image running the api-gateway and the syncing-server as co-located
# processes under one supervisord?
#
# This is the ONLY condition under which minting a shared secret is sound. The
# secret has to be byte-identical in both halves; a value minted in one
# container is not shared with a syncing-server in a DIFFERENT container, and
# minting there would hand the signer and the verifier different keys — strictly
# worse than no secret, because the lane would be advertised and then every
# durable command would fail verification. The supervisord config is the
# authority rather than a hardcoded `true`: if this image is ever split into
# per-service configs, the halves stop being co-located and the mint stops with
# them, without anyone having to remember this file.
srn_grpc_halves_colocated() {
  local conf
  conf="${SRN_SUPERVISORD_CONF:-/etc/supervisord.conf}"
  [ -r "$conf" ] || return 1
  grep -q '^\[program:api-gateway\]' "$conf" || return 1
  grep -q '^\[program:syncing-server\]' "$conf" || return 1
  return 0
}

# 64 hexadecimal characters = 32 bytes. Echoed on stdout, empty on failure.
srn_mint_hex32() {
  local minted
  minted="$(openssl rand -hex 32 2>/dev/null || true)"
  if [ "$(srn_byte_length "$minted")" -ne 64 ]; then
    # openssl is installed in this image (server/Dockerfile apk's it, and the
    # entrypoint already depends on it) — this is for anywhere else the helper
    # is reused, and for the tests.
    minted="$(od -An -vtx1 -N32 /dev/urandom 2>/dev/null | tr -d ' \t\n' || true)"
  fi
  case "$minted" in
    *[!0-9a-fA-F]*) minted="" ;;
  esac
  if [ "$(srn_byte_length "$minted")" -ne 64 ]; then
    minted=""
  fi
  printf '%s' "$minted"
}

# Resolve SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET and export it under BOTH
# names the two halves read, so the generated dotenvs cannot disagree:
#
#   SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET              syncing-server
#   API_GATEWAY_SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET  api-gateway
#
# Reports the outcome in SRN_INTERNAL_GRPC_SECRET_STATE, never the value:
#   supplied          the operator's own value, >= 32 bytes — left untouched
#   persisted         a previously minted value, reloaded from disk
#   minted-persisted  freshly minted and written to the persistent volume
#   minted-ephemeral  freshly minted, but the persistent store is not writable
#   not-colocated     refused to mint (see srn_grpc_halves_colocated)
#   mint-failed       no randomness source produced 32 bytes
#
# Always returns 0: the caller decides what an unusable outcome means, and an
# unset secret is byte-identical to the behaviour before this file existed.
srn_prepare_internal_grpc_secret() {
  local supplied persisted minted secret_file secret_dir
  SRN_INTERNAL_GRPC_SECRET_STATE="unset"
  secret_file="${SRN_INTERNAL_GRPC_SECRET_FILE:-/opt/server/packages/api-gateway/data/internal-grpc-auth-secret}"
  supplied="${SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET:-}"

  # NEVER overwrite a usable operator value, and never persist one either: the
  # operator's .env is already its home, and a second copy on a volume is a
  # second place to leak it from and a second place for it to go stale.
  if [ "$(srn_byte_length "$supplied")" -ge 32 ]; then
    SRN_INTERNAL_GRPC_SECRET_STATE="supplied"
    export SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET="$supplied"
    export API_GATEWAY_SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET="$supplied"
    return 0
  fi

  if ! srn_grpc_halves_colocated; then
    SRN_INTERNAL_GRPC_SECRET_STATE="not-colocated"
    return 0
  fi

  # Persisted, not per-boot. supervisord can restart either half on its own, and
  # a value regenerated on each start would hand a restarted api-gateway a key
  # the still-running syncing-server does not have — every durable command would
  # then fail verification on a lane that is still advertised.
  if [ -r "$secret_file" ]; then
    persisted="$(tr -d '\r\n' < "$secret_file" 2>/dev/null || true)"
    if [ "$(srn_byte_length "$persisted")" -ge 32 ]; then
      SRN_INTERNAL_GRPC_SECRET_STATE="persisted"
      export SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET="$persisted"
      export API_GATEWAY_SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET="$persisted"
      return 0
    fi
  fi

  minted="$(srn_mint_hex32)"
  if [ -z "$minted" ]; then
    SRN_INTERNAL_GRPC_SECRET_STATE="mint-failed"
    return 0
  fi

  secret_dir="$(dirname "$secret_file")"
  if mkdir -p "$secret_dir" 2>/dev/null &&
    (umask 077 && printf '%s\n' "$minted" >"$secret_file") 2>/dev/null; then
    chmod 600 "$secret_file" 2>/dev/null || true
    SRN_INTERNAL_GRPC_SECRET_STATE="minted-persisted"
  else
    SRN_INTERNAL_GRPC_SECRET_STATE="minted-ephemeral"
  fi

  export SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET="$minted"
  export API_GATEWAY_SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET="$minted"
  return 0
}

# Can a TCP connection be made to a `host:port` gRPC target? Bounded: it answers
# "no" rather than waiting forever, because "no" has a safe outcome here.
srn_grpc_endpoint_reachable() {
  local target host port attempts attempt
  target="${1:-}"
  [ -n "$target" ] || return 1
  target="${target#*://}"
  host="${target%:*}"
  port="${target##*:}"
  # The entrypoint writes these as 0.0.0.0:<port> — a wildcard BIND address. The
  # kernel remaps a connect() to it, but probe the loopback address the gateway
  # will really reach.
  case "$host" in
    '' | 0.0.0.0 | '::' | '[::]') host="127.0.0.1" ;;
  esac
  case "$port" in
    '' | *[!0-9]*) return 1 ;;
  esac

  attempts="${SRN_GRPC_PROBE_ATTEMPTS:-15}"
  case "$attempts" in
    '' | *[!0-9]*) attempts=15 ;;
  esac
  attempt=0
  while [ "$attempt" -lt "$attempts" ]; do
    attempt=$((attempt + 1))
    if nc -z "$host" "$port" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$attempt" -ge "$attempts" ]; then
      break
    fi
    sleep "${SRN_GRPC_PROBE_INTERVAL_SECONDS:-1}"
  done
  return 1
}

# Decide the api-gateway's internal transport and export SERVICE_PROXY_TYPE for
# the gateway process. An exported value WINS over the dotenv (dotenv never
# overrides an inherited variable), so nothing has to rewrite a file.
#
# Why the default lives here and not in docker-entrypoint.sh: GRPCServiceProxy
# has NO HTTP fallback. `validateSession` runs on every authenticated request
# and, over gRPC, retries three times on UNAVAILABLE and then throws;
# `callSyncingServer` delegates items/sync to GRPCSyncingServerServiceProxy,
# which rejects. So a `grpc` setting pointed at a gRPC listener that is not
# answering is not a degraded lane, it is a dead API. The entrypoint cannot tell
# — it runs before supervisord has started anything, and then supervisord never
# returns to it. This runs as the api-gateway's own launcher, after the backends
# are up, which is the first and only moment the condition is knowable.
#
# `auto` and empty both mean "decide here". `auto` exists so a generated .env
# can SAY what it is doing instead of relying on an empty value to mean
# something; it is also fail-safe, because the gateway only ever treats the
# exact string `grpc` as gRPC, so an `auto` that somehow reached it unprocessed
# selects the HTTP proxies rather than a transport with no fallback.
#
# Reports in SRN_SERVICE_PROXY_TYPE_DECISION, and always returns 0:
#   operator                  an explicit value was supplied; untouched
#   grpc-default              defaulted to grpc; every condition held
#   not-colocated             no co-located syncing-server to talk gRPC to
#   no-grpc-urls              a gRPC dial target is missing
#   no-secret                 no usable durable-command secret, so the lane
#                             would stay closed anyway — gRPC would buy nothing
#                             and only remove the HTTP fallback
#   auth-grpc-unreachable     the listener did not answer; HTTP is kept
#   syncing-grpc-unreachable  likewise
srn_resolve_service_proxy_type() {
  local configured auth_target sync_target
  SRN_SERVICE_PROXY_TYPE_DECISION="operator"

  configured="${SERVICE_PROXY_TYPE:-}"
  if [ -z "$configured" ]; then
    configured="${API_GATEWAY_SERVICE_PROXY_TYPE:-}"
  fi
  case "$(printf '%s' "$configured" | tr '[:upper:]' '[:lower:]')" in
    '' | auto) configured="" ;;
  esac
  if [ -n "$configured" ]; then
    export SERVICE_PROXY_TYPE="$configured"
    return 0
  fi
  # An `auto` already in the environment must not survive into the gateway as a
  # literal value; the branches below either replace it or leave HTTP selected.
  unset SERVICE_PROXY_TYPE

  if ! srn_grpc_halves_colocated; then
    SRN_SERVICE_PROXY_TYPE_DECISION="not-colocated"
    return 0
  fi

  auth_target="${API_GATEWAY_AUTH_SERVER_GRPC_URL:-}"
  sync_target="${API_GATEWAY_SYNCING_SERVER_GRPC_URL:-}"
  if [ -z "$auth_target" ] || [ -z "$sync_target" ]; then
    SRN_SERVICE_PROXY_TYPE_DECISION="no-grpc-urls"
    return 0
  fi

  if [ "$(srn_byte_length "${SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET:-}")" -lt 32 ]; then
    SRN_SERVICE_PROXY_TYPE_DECISION="no-secret"
    return 0
  fi

  if ! srn_grpc_endpoint_reachable "$auth_target"; then
    SRN_SERVICE_PROXY_TYPE_DECISION="auth-grpc-unreachable"
    return 0
  fi
  if ! srn_grpc_endpoint_reachable "$sync_target"; then
    SRN_SERVICE_PROXY_TYPE_DECISION="syncing-grpc-unreachable"
    return 0
  fi

  export SERVICE_PROXY_TYPE="grpc"
  SRN_SERVICE_PROXY_TYPE_DECISION="grpc-default"
  return 0
}
