#!/usr/bin/env bash
#
# =============================================================================
# Standard Red Notes — LXC / bare-metal installer (Debian/Ubuntu).
#
# Provisions the ALL-IN-ONE deployment inside a fresh Debian 12+ / Ubuntu 22.04+
# LXC *system* container (or any VM/host): installs Node + Yarn + nginx, builds
# the server + web app, configures the single-process home-server (embedded
# sqlite + in-memory cache + in-process events — no MySQL; Redis is optional
# for worker WebSocket sync), installs a
# systemd service for it, and points nginx at the built SPA + the API.
#
# Idempotent: upgrades build and health-check a release before atomically moving
# the live `current` symlink. Generated secrets are created once under DATA_DIR.
#
# Usage (inside the container, as root):
#   REPO_URL=https://github.com/<owner>/standard-red-notes.git ./install.sh
# or from an existing checkout bind-mounted / cloned at $APP_DIR:
#   ./install.sh
#
# Environment overrides (all optional):
#   REPO_URL     git URL to clone when $APP_DIR has no checkout (default: unset)
#   REPO_REF     explicit branch/tag/commit to resolve (default: checkout HEAD)
#   EXPECTED_COMMIT  optional required full SHA after ref resolution
#   APP_DIR      repo checkout location        (default: /opt/standard-red-notes)
#   DATA_DIR     persistent data (sqlite+uploads+secrets)
#                                        (default: /var/lib/standard-red-notes)
#   APP_USER     service account               (default: standard-red-notes)
#   HTTP_PORT    nginx listen port                                (default: 80)
#   NODE_MAJOR   Node.js major version                            (default: 26)
#   PUBLIC_URL   canonical browser-facing origin (persisted across upgrades)
#   SRN_DEPLOY_VERSION  optional safe release version exposed by readiness
#   REDIS_HOST   optional Redis host; required to enable WebSocket sync
#   REDIS_PORT   optional Redis port                         (default: 6379)
#   WEBSOCKET_SYNC_ENABLED  exact false disables WebSocket sync (default: true)
#   WEBSOCKET_SYNC_ALLOWED_ORIGINS  optional comma-separated exact origins
#   FILE_DOWNLOAD_DEADLINE_MS  positive whole-request deadline (default: 30000)
# =============================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-}"
REPO_REF="${REPO_REF:-}"
EXPECTED_COMMIT="${EXPECTED_COMMIT:-}"
APP_DIR="${APP_DIR:-/opt/standard-red-notes}"
DATA_DIR="${DATA_DIR:-/var/lib/standard-red-notes}"
APP_USER="${APP_USER:-standard-red-notes}"
HTTP_PORT="${HTTP_PORT:-80}"
NODE_MAJOR="${NODE_MAJOR:-26}"
PUBLIC_URL_WAS_SET="${PUBLIC_URL+x}"
PUBLIC_URL="${PUBLIC_URL:-}"
SRN_DEPLOY_VERSION="${SRN_DEPLOY_VERSION:-}"
REDIS_HOST="${REDIS_HOST:-}"
REDIS_PORT="${REDIS_PORT:-6379}"
WEBSOCKET_SYNC_ENABLED="${WEBSOCKET_SYNC_ENABLED:-true}"
WEBSOCKET_SYNC_ALLOWED_ORIGINS="${WEBSOCKET_SYNC_ALLOWED_ORIGINS:-}"
WEBSOCKET_SYNC_MAX_SOCKETS_PER_USER="${WEBSOCKET_SYNC_MAX_SOCKETS_PER_USER:-4}"
WEBSOCKET_SYNC_REDIS_KEY_PREFIX="${WEBSOCKET_SYNC_REDIS_KEY_PREFIX:-srn:ws-sync:v1}"
WEBSOCKET_SYNC_REDIS_OPERATION_TIMEOUT_MS="${WEBSOCKET_SYNC_REDIS_OPERATION_TIMEOUT_MS:-1500}"
WEBSOCKET_SYNC_COMMAND_LEASE_TTL_MS="${WEBSOCKET_SYNC_COMMAND_LEASE_TTL_MS:-30000}"
WEBSOCKET_SYNC_SOCKET_LEASE_TTL_MS="${WEBSOCKET_SYNC_SOCKET_LEASE_TTL_MS:-75000}"
FILE_DOWNLOAD_DEADLINE_MS="${FILE_DOWNLOAD_DEADLINE_MS:-30000}"

RELEASES_DIR="${APP_DIR}/.releases"
CURRENT_LINK="${APP_DIR}/current"
PREVIOUS_LINK="${APP_DIR}/previous"
WEB_ROOT="${CURRENT_LINK}/app/packages/web/dist"
LAUNCHER="/usr/local/bin/standard-red-notes-run"
ADMIN_LAUNCHER="/usr/local/bin/srn-admin"
NGINX_SITE="/etc/nginx/sites-available/standard-red-notes.conf"
NGINX_SITE_LINK="/etc/nginx/sites-enabled/standard-red-notes.conf"
UNIT_SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "${UNIT_SRC_DIR}/release.sh"

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

validate_positive_safe_integer() {
  local name="$1" value="$2" maximum="9007199254740991"
  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]] || \
     [ "${#value}" -gt "${#maximum}" ] || \
     { [ "${#value}" -eq "${#maximum}" ] && [[ "${value}" > "${maximum}" ]]; }; then
    die "${name} must be a positive safe integer."
  fi
}

validate_positive_safe_integer FILE_DOWNLOAD_DEADLINE_MS "${FILE_DOWNLOAD_DEADLINE_MS}"

# Validate operator-supplied release metadata before installing packages,
# creating users, or mutating any live deployment state.
if [[ -n "${SRN_DEPLOY_VERSION}" && ! "${SRN_DEPLOY_VERSION}" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$ ]]; then
  die "SRN_DEPLOY_VERSION must be 1-128 safe ASCII version characters."
fi

validate_public_url_origin() {
  PUBLIC_URL_CANDIDATE="${1:-}" "${NODE_BIN}" -e '
    const value = process.env.PUBLIC_URL_CANDIDATE ?? ""
    if (value === "") process.exit(0)
    if (value.length > 2048) process.exit(1)
    let parsed
    try { parsed = new URL(value) } catch { process.exit(1) }
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) process.exit(1)
    if (!parsed.hostname || parsed.username || parsed.password) process.exit(1)
    if (parsed.origin !== value) process.exit(1)
  '
}

[ "$(id -u)" -eq 0 ] || die "Run as root (needs to install packages + a systemd unit)."
command -v systemctl >/dev/null 2>&1 || die "systemd is required (run inside a system container, not an app container)."

wait_live_health() {
  local elapsed=0
  while [ "${elapsed}" -lt 120 ]; do
    curl -fsS --max-time 3 "http://127.0.0.1:${HTTP_PORT}/healthcheck/readiness" >/dev/null 2>&1 && return 0
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

verify_live_deployment_identity() {
  local expected_release="$1" expected_revision="$2" expected_version="$3" live_release
  live_release="$(release_link_target "${CURRENT_LINK}" "${RELEASES_DIR}")" || return 1
  [ "${live_release}" = "${expected_release}" ] || return 1
  local identity_args=(
    --app-url "http://127.0.0.1:${HTTP_PORT}"
    --expected-revision "${expected_revision}"
  )
  if [ -n "${expected_version}" ]; then
    identity_args+=(--expected-version "${expected_version}")
  fi
  "${NODE_BIN}" "${expected_release}/scripts/verify-deployment-identity.mjs" "${identity_args[@]}"
}

read_trusted_release_identity() {
  local encoded
  encoded="$(release_read_deployment_identity "$1" "${NODE_BIN}")" || return 1
  case "${encoded}" in
    *'|'*) ;;
    *) return 1 ;;
  esac
  TRUSTED_RELEASE_REVISION="${encoded%%|*}"
  TRUSTED_RELEASE_VERSION="${encoded#*|}"
}

if [ "${1:-}" = "--rollback" ]; then
  log "Switching current and previous releases"
  NODE_BIN="$(command -v node)" || die "Rollback requires the installed Node.js runtime."
  ACTIVE_RELEASE="$(release_link_target "${CURRENT_LINK}" "${RELEASES_DIR}")" || \
    die "Current release is not a valid managed release."
  ROLLBACK_RELEASE="$(release_link_target "${PREVIOUS_LINK}" "${RELEASES_DIR}")" || \
    die "No valid previous release is available."
  read_trusted_release_identity "${ACTIVE_RELEASE}" || \
    die "The active release does not contain a trusted sealed deployment identity."
  ACTIVE_REVISION="${TRUSTED_RELEASE_REVISION}"
  ACTIVE_VERSION="${TRUSTED_RELEASE_VERSION}"
  read_trusted_release_identity "${ROLLBACK_RELEASE}" || \
    die "The rollback release does not contain a trusted sealed deployment identity."
  ROLLBACK_REVISION="${TRUSTED_RELEASE_REVISION}"
  ROLLBACK_VERSION="${TRUSTED_RELEASE_VERSION}"
  release_swap_current_previous "${CURRENT_LINK}" "${PREVIOUS_LINK}" "${RELEASES_DIR}" || \
    die "No valid previous release is available."
  if install -o root -g root -m 0644 "${ROLLBACK_RELEASE}/.srn-nginx.conf" "${NGINX_SITE}" && \
    nginx -t && systemctl restart standard-red-notes.service nginx && wait_live_health && \
    verify_live_deployment_identity "${ROLLBACK_RELEASE}" "${ROLLBACK_REVISION}" "${ROLLBACK_VERSION}"; then
    log "Rollback complete."
    exit 0
  fi
  warn "Rollback target was unhealthy; restoring the release that was active."
  release_swap_current_previous "${CURRENT_LINK}" "${PREVIOUS_LINK}" "${RELEASES_DIR}" || \
    die "Rollback recovery could not restore the release links."
  install -o root -g root -m 0644 "${ACTIVE_RELEASE}/.srn-nginx.conf" "${NGINX_SITE}" || \
    die "Release links were restored, but the active nginx config could not be restored."
  if ! nginx -t || ! systemctl restart standard-red-notes.service nginx || ! wait_live_health || \
    ! verify_live_deployment_identity "${ACTIVE_RELEASE}" "${ACTIVE_REVISION}" "${ACTIVE_VERSION}"; then
    die "Release links and config were restored, but the active release identity did not recover."
  fi
  die "Rollback target was unhealthy; the previously active release was restored."
elif [ -n "${1:-}" ]; then
  die "Unknown argument: $1 (supported: --rollback)"
fi

# -----------------------------------------------------------------------------
log "Installing OS packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git nginx openssl python3 make g++

# -----------------------------------------------------------------------------
log "Installing Node.js ${NODE_MAJOR}.x + Yarn (Corepack 0.35.0)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" != "${NODE_MAJOR}" ]; then
  key_file="$(mktemp)"
  curl --proto '=https' --tlsv1.2 -fsSL \
    https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "${key_file}"
  key_fingerprint="$(gpg --batch --show-keys --with-colons "${key_file}" | awk -F: '$1 == "fpr" { print toupper($10); exit }')"
  [ "${key_fingerprint}" = "6F71F525282841EEDAF851B42F59B5F99B1BE0B4" ] || \
    die "NodeSource signing-key fingerprint mismatch."
  gpg --batch --yes --dearmor --output /usr/share/keyrings/nodesource.gpg "${key_file}"
  rm -f -- "${key_file}"
  printf 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' \
    "${NODE_MAJOR}" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y --no-install-recommends nodejs
fi
npm install --global corepack@0.35.0
corepack enable
NODE_BIN="$(command -v node)"
log "Using $(node -v) at ${NODE_BIN}"

# -----------------------------------------------------------------------------
log "Creating service account + directories"
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
fi
mkdir -p "${APP_DIR}" "${DATA_DIR}/database" "${DATA_DIR}/uploads" \
         "${DATA_DIR}/caldav" "${DATA_DIR}/reminder-delivery" "${RELEASES_DIR}"

# PUBLIC_URL is operational identity, not release content. Persist it outside
# the immutable release tree so upgrades cannot silently clear assistant OAuth,
# workflow-host isolation, or any other canonical-origin consumer. Never source
# this file as shell; it is parsed as one inert line and validated as an origin.
PUBLIC_URL_CONFIG_DIR="/etc/standard-red-notes"
PUBLIC_URL_CONFIG_FILE="${PUBLIC_URL_CONFIG_DIR}/public-url"
install -d -o root -g root -m 0755 "${PUBLIC_URL_CONFIG_DIR}"
if [ -z "${PUBLIC_URL_WAS_SET}" ] && [ -e "${PUBLIC_URL_CONFIG_FILE}" ]; then
  [ -f "${PUBLIC_URL_CONFIG_FILE}" ] && [ ! -L "${PUBLIC_URL_CONFIG_FILE}" ] || \
    die "Persisted PUBLIC_URL must be a regular non-symlink file: ${PUBLIC_URL_CONFIG_FILE}"
  [ "$(stat -c '%u:%a' "${PUBLIC_URL_CONFIG_FILE}")" = "0:600" ] || \
    die "Persisted PUBLIC_URL must be owned by root with mode 600: ${PUBLIC_URL_CONFIG_FILE}"
  mapfile -t PUBLIC_URL_LINES < "${PUBLIC_URL_CONFIG_FILE}"
  [ "${#PUBLIC_URL_LINES[@]}" -eq 1 ] || \
    die "Persisted PUBLIC_URL must contain exactly one line."
  PUBLIC_URL="${PUBLIC_URL_LINES[0]}"
elif [ -z "${PUBLIC_URL_WAS_SET}" ] && [ -f "${CURRENT_LINK}/server/packages/home-server/.env" ]; then
  mapfile -t PUBLIC_URL_LINES < <(grep -E '^PUBLIC_URL=' "${CURRENT_LINK}/server/packages/home-server/.env" || true)
  [ "${#PUBLIC_URL_LINES[@]}" -le 1 ] || die "Existing home-server .env contains duplicate PUBLIC_URL values."
  if [ "${#PUBLIC_URL_LINES[@]}" -eq 1 ]; then
    PUBLIC_URL="${PUBLIC_URL_LINES[0]#PUBLIC_URL=}"
    PUBLIC_URL_WAS_SET="migrated"
  fi
fi
validate_public_url_origin "${PUBLIC_URL}" || \
  die "PUBLIC_URL must be empty or one canonical HTTP(S) origin with no path, credentials, query, or fragment."
if [ -n "${PUBLIC_URL_WAS_SET}" ]; then
  PUBLIC_URL_TEMP="$(mktemp "${PUBLIC_URL_CONFIG_DIR}/public-url.new.XXXXXX")"
  printf '%s\n' "${PUBLIC_URL}" > "${PUBLIC_URL_TEMP}"
  chown root:root "${PUBLIC_URL_TEMP}"
  chmod 0600 "${PUBLIC_URL_TEMP}"
  mv -Tf -- "${PUBLIC_URL_TEMP}" "${PUBLIC_URL_CONFIG_FILE}"
  log "Persisted canonical PUBLIC_URL in ${PUBLIC_URL_CONFIG_FILE}"
fi

# -----------------------------------------------------------------------------
log "Resolving an immutable source commit"
if [ -d "${APP_DIR}/.git" ]; then
  SOURCE_DIR="${APP_DIR}"
elif [ -d "${APP_DIR}/source/.git" ]; then
  SOURCE_DIR="${APP_DIR}/source"
elif [ -n "${REPO_URL}" ]; then
  [ -n "${REPO_REF}" ] || die "REPO_REF is required when cloning; use a full commit SHA or immutable tag."
  SOURCE_DIR="${APP_DIR}/source"
  git clone --no-checkout "${REPO_URL}" "${SOURCE_DIR}"
else
  die "No Git checkout found. Set REPO_URL with REPO_REF, or place a checkout at ${APP_DIR}."
fi
if [ -n "${EXPECTED_COMMIT}" ]; then
  printf '%s' "${EXPECTED_COMMIT}" | grep -Eqi '^[0-9a-f]{40}$' || die "EXPECTED_COMMIT must be a full SHA."
fi
if [ -n "${REPO_REF}" ]; then
  if ! printf '%s' "${REPO_REF}" | grep -Eqi '^[0-9a-f]{40}$' && [ -z "${EXPECTED_COMMIT}" ]; then
    die "Symbolic REPO_REF values require EXPECTED_COMMIT=<full-sha>."
  fi
  git -C "${SOURCE_DIR}" fetch --all --tags --prune
  if git -C "${SOURCE_DIR}" show-ref --verify --quiet "refs/tags/${REPO_REF}"; then
    DEPLOY_COMMIT="$(git -C "${SOURCE_DIR}" rev-parse --verify "refs/tags/${REPO_REF}^{commit}")"
  elif git -C "${SOURCE_DIR}" show-ref --verify --quiet "refs/remotes/origin/${REPO_REF}"; then
    DEPLOY_COMMIT="$(git -C "${SOURCE_DIR}" rev-parse --verify "refs/remotes/origin/${REPO_REF}^{commit}")"
  else
    DEPLOY_COMMIT="$(git -C "${SOURCE_DIR}" rev-parse --verify "${REPO_REF}^{commit}")" || \
      die "REPO_REF does not resolve to a commit: ${REPO_REF}"
  fi
else
  DEPLOY_COMMIT="$(git -C "${SOURCE_DIR}" rev-parse --verify "HEAD^{commit}")"
fi
printf '%s' "${DEPLOY_COMMIT}" | grep -Eq '^[0-9a-f]{40}$' || die "Source ref did not resolve to a full commit SHA."
if printf '%s' "${REPO_REF}" | grep -Eqi '^[0-9a-f]{40}$' && \
  [ "${DEPLOY_COMMIT}" != "$(printf '%s' "${REPO_REF}" | tr '[:upper:]' '[:lower:]')" ]; then
  die "Resolved commit ${DEPLOY_COMMIT} does not match full-SHA REPO_REF ${REPO_REF}."
fi
if [ -n "${EXPECTED_COMMIT}" ] && \
  [ "${DEPLOY_COMMIT}" != "$(printf '%s' "${EXPECTED_COMMIT}" | tr '[:upper:]' '[:lower:]')" ]; then
  die "Resolved commit ${DEPLOY_COMMIT} does not match EXPECTED_COMMIT ${EXPECTED_COMMIT}."
fi
git -C "${SOURCE_DIR}" cat-file -e "${DEPLOY_COMMIT}^{commit}"
# The sealed marker below is what an operator curls during an incident to learn
# WHICH COMMIT IS LIVE. DEPLOY_COMMIT is already proven to be a full SHA above,
# but SRN_DEPLOY_VERSION is optional — leaving it blank published `"version":""`,
# which reads as a serialization bug rather than as "this release is unversioned".
# Derive it from the proven commit instead (same scheme as scripts/setup.sh), so
# the marker never carries a silently empty field.
if [ -z "${SRN_DEPLOY_VERSION}" ]; then
  SRN_DEPLOY_VERSION="src-$(printf '%s' "${DEPLOY_COMMIT}" | cut -c1-12)"
fi
release_create_stage "${SOURCE_DIR}" "${RELEASES_DIR}" "${DEPLOY_COMMIT}"
trap 'release_cleanup_stage "${RELEASE_STAGE:-}" "${RELEASES_DIR}"' EXIT
DEPLOY_ROOT="${RELEASE_STAGE}"
HS_DIR="${DEPLOY_ROOT}/server/packages/home-server"
printf '{"revision":"%s","version":"%s"}\n' \
  "${DEPLOY_COMMIT}" "${SRN_DEPLOY_VERSION}" > "${DEPLOY_ROOT}/.srn-deployment.json"
chmod 0444 "${DEPLOY_ROOT}/.srn-deployment.json"

# -----------------------------------------------------------------------------
log "Building the server workspace (home-server)"
( cd "${DEPLOY_ROOT}/server" && CI=true yarn install --immutable && CI=true yarn build )

log "Building the web app bundle"
(
  cd "${DEPLOY_ROOT}/app"
  printf -- '--ignore-engines true\n' > "${HOME:-/root}/.yarnrc"
  CI=true yarn workspaces focus @standardnotes/web
  CI=true NODE_OPTIONS=--no-deprecation yarn build:web
)

[ -f "${DEPLOY_ROOT}/app/packages/web/dist/index.html" ] || die "Staged web bundle is missing index.html."
[ -f "${HS_DIR}/dist/bin/server.js" ] || die "Staged backend entrypoint is missing."

# -----------------------------------------------------------------------------
log "Generating / loading persistent secrets"
SECRETS_DIR="${PUBLIC_URL_CONFIG_DIR}/private"
SECRETS_FILE="${SECRETS_DIR}/secrets.env"
LEGACY_SECRETS_FILE="${DATA_DIR}/secrets.env"
if [ -e "${SECRETS_DIR}" ] || [ -L "${SECRETS_DIR}" ]; then
  [ -d "${SECRETS_DIR}" ] && [ ! -L "${SECRETS_DIR}" ] || \
    die "Persistent secret path must be a real directory, not a symlink: ${SECRETS_DIR}"
else
  install -d -o root -g root -m 0700 "${SECRETS_DIR}"
fi
[ -d "${SECRETS_DIR}" ] && [ ! -L "${SECRETS_DIR}" ] && \
  [ "$(stat -c '%u:%a' "${SECRETS_DIR}")" = "0:700" ] || \
  die "Persistent secret directory must be root-owned mode 700: ${SECRETS_DIR}"
ASSISTANT_SUBSCRIPTION_TOKEN_PATH="${DATA_DIR}/assistant-subscription.json"
LEGACY_ASSISTANT_SUBSCRIPTION_TOKEN_PATH="${CURRENT_LINK}/server/packages/home-server/data/assistant-subscription.json"

validate_pairing_file() {
  local file="$1"
  if [ -e "${file}" ]; then
    [ -f "${file}" ] && [ ! -L "${file}" ] || \
      die "Assistant pairing state must be a regular non-symlink file: ${file}"
  fi
}

read_hex_secret() {
  local file="$1" name="$2" required="$3" value
  mapfile -t SECRET_ASSIGNMENTS < <(grep -E "^${name}=" "${file}" || true)
  [ "${#SECRET_ASSIGNMENTS[@]}" -le 1 ] || die "${name} is assigned more than once in ${file}."
  if [ "${#SECRET_ASSIGNMENTS[@]}" -eq 0 ]; then
    [ "${required}" = false ] || die "${name} is missing from ${file}."
    READ_SECRET_STATE=missing
    READ_SECRET_VALUE=""
    return
  fi
  value="${SECRET_ASSIGNMENTS[0]#*=}"
  [[ "${value}" =~ ^[0-9a-fA-F]{64}$ ]] || \
    die "${name} in ${file} must be exactly 64 hexadecimal characters."
  READ_SECRET_STATE=valid
  READ_SECRET_VALUE="${value}"
}

validate_secret_document() {
  local file="$1" line assignment_count=0
  while IFS= read -r line || [ -n "${line}" ]; do
    [ -n "${line}" ] || \
      die "${file} contains a blank line; installer secrets must use the exact generated schema."
    [[ "${line}" =~ ^(AUTH_JWT_SECRET|JWT_SECRET|ENCRYPTION_SERVER_KEY|PSEUDO_KEY_PARAMS_KEY|VALET_TOKEN_SECRET|WEB_SOCKET_CONNECTION_TOKEN_SECRET|WEBSOCKET_GATEWAY_INTERNAL_SECRET|ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY)=[0-9a-fA-F]{64}$ ]] || \
      die "${file} contains an unexpected or malformed entry; refusing to interpret it as installer secrets."
    assignment_count=$((assignment_count + 1))
  done < "${file}"
  [ "${assignment_count}" = 5 ] || [ "${assignment_count}" = 6 ] || \
    [ "${assignment_count}" = 7 ] || [ "${assignment_count}" = 8 ] || \
    die "${file} must contain the five legacy base secrets, optional WebSocket secrets, and optional assistant pairing key."
}

append_migrated_optional_secret() {
  local file="$1" name="$2" state="$3" value="$4"
  [ "${state}" = missing ] && return 0
  [ "${state}" = valid ] || die "Unexpected migration state for ${name}."
  printf '%s=%s\n' "${name}" "${value}" >> "${file}"
}

verify_migrated_optional_secret() {
  local file="$1" name="$2" expected_state="$3" expected_value="$4"
  read_hex_secret "${file}" "${name}" false
  [ "${READ_SECRET_STATE}" = "${expected_state}" ] && \
    [ "${READ_SECRET_VALUE}" = "${expected_value}" ] || \
    die "Root-owned ${name} failed post-migration verification."
}

persist_missing_websocket_secrets() {
  local connection_secret internal_secret temporary owner group
  read_hex_secret "${SECRETS_FILE}" WEB_SOCKET_CONNECTION_TOKEN_SECRET false
  connection_secret="${READ_SECRET_VALUE:-$(openssl rand -hex 32)}"
  read_hex_secret "${SECRETS_FILE}" WEBSOCKET_GATEWAY_INTERNAL_SECRET false
  internal_secret="${READ_SECRET_VALUE:-$(openssl rand -hex 32)}"

  read_hex_secret "${SECRETS_FILE}" WEB_SOCKET_CONNECTION_TOKEN_SECRET false
  [ "${READ_SECRET_STATE}" = missing ] || {
    read_hex_secret "${SECRETS_FILE}" WEBSOCKET_GATEWAY_INTERNAL_SECRET false
    [ "${READ_SECRET_STATE}" = missing ] || return 0
  }

  temporary="$(mktemp "${SECRETS_DIR}/secrets.env.websocket.XXXXXX")"
  owner="$(stat -c '%u' "${SECRETS_FILE}")"
  group="$(stat -c '%g' "${SECRETS_FILE}")"
  if ! cp -- "${SECRETS_FILE}" "${temporary}" || \
     { grep -q '^WEB_SOCKET_CONNECTION_TOKEN_SECRET=' "${temporary}" || \
       printf 'WEB_SOCKET_CONNECTION_TOKEN_SECRET=%s\n' "${connection_secret}" >> "${temporary}"; } || \
     { grep -q '^WEBSOCKET_GATEWAY_INTERNAL_SECRET=' "${temporary}" || \
       printf 'WEBSOCKET_GATEWAY_INTERNAL_SECRET=%s\n' "${internal_secret}" >> "${temporary}"; } || \
     ! chown "${owner}:${group}" "${temporary}" || \
     ! chmod 0600 "${temporary}" || \
     ! mv -Tf -- "${temporary}" "${SECRETS_FILE}"; then
    rm -f -- "${temporary}"
    die "Could not atomically persist the WebSocket gateway secrets."
  fi
}

persist_assistant_secret() {
  local key="$1" temporary owner group
  temporary="$(mktemp "${SECRETS_DIR}/secrets.env.new.XXXXXX")"
  owner="$(stat -c '%u' "${SECRETS_FILE}")"
  group="$(stat -c '%g' "${SECRETS_FILE}")"
  if ! cp -- "${SECRETS_FILE}" "${temporary}" || \
     ! printf 'ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=%s\n' "${key}" >> "${temporary}" || \
     ! chown "${owner}:${group}" "${temporary}" || \
     ! chmod 0600 "${temporary}" || \
     ! mv -Tf -- "${temporary}" "${SECRETS_FILE}"; then
    rm -f -- "${temporary}"
    die "Could not atomically persist the internal assistant pairing key."
  fi
}

verify_pairing_store() {
  local file="$1" key="$2"
  # Send the key over stdin, never argv. This authenticates the AES-GCM envelope
  # before an upgrade accepts or migrates durable ciphertext.
  printf '%s' "${key}" | "${NODE_BIN}" -e '
    const crypto = require("crypto")
    const fs = require("fs")
    const file = process.argv[1]
    const key = fs.readFileSync(0, "utf8").trim()
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"))
    const hex = (value, bytes) => typeof value === "string" && new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)
    if (envelope?.v !== 1 || !hex(envelope.iv, 12) || !hex(envelope.tag, 16) || !hex(envelope.data, envelope.data.length / 2)) process.exit(2)
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(envelope.iv, "hex"))
    decipher.setAuthTag(Buffer.from(envelope.tag, "hex"))
    JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "hex")), decipher.final()]).toString("utf8"))
  ' "${file}" >/dev/null 2>&1 || \
    die "Assistant pairing state at ${file} cannot be authenticated with the persisted key. Restore the matching secrets.env before upgrading."
}

validate_pairing_file "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}"
validate_pairing_file "${LEGACY_ASSISTANT_SUBSCRIPTION_TOKEN_PATH}"

CURRENT_HOME_ENV="${CURRENT_LINK}/server/packages/home-server/.env"
if [ ! -e "${SECRETS_FILE}" ] && [ -e "${LEGACY_SECRETS_FILE}" ]; then
  [ -f "${LEGACY_SECRETS_FILE}" ] && [ ! -L "${LEGACY_SECRETS_FILE}" ] || \
    die "Legacy persistent secrets must be a regular non-symlink file: ${LEGACY_SECRETS_FILE}"
  [ "$(stat -c '%a' "${LEGACY_SECRETS_FILE}")" = 600 ] || \
    die "Legacy persistent secrets must have mode 600 before migration."
  LEGACY_SECRETS_OWNER="$(stat -c '%u' "${LEGACY_SECRETS_FILE}")"
  APP_UID="$(id -u "${APP_USER}")"
  [ "${LEGACY_SECRETS_OWNER}" = 0 ] || [ "${LEGACY_SECRETS_OWNER}" = "${APP_UID}" ] || \
    die "Legacy persistent secrets must be owned by root or ${APP_USER}."
  validate_secret_document "${LEGACY_SECRETS_FILE}"
  for REQUIRED_LEGACY_SECRET in AUTH_JWT_SECRET JWT_SECRET ENCRYPTION_SERVER_KEY PSEUDO_KEY_PARAMS_KEY VALET_TOKEN_SECRET; do
    read_hex_secret "${LEGACY_SECRETS_FILE}" "${REQUIRED_LEGACY_SECRET}" true
    printf -v "MIGRATION_${REQUIRED_LEGACY_SECRET}" '%s' "${READ_SECRET_VALUE}"
  done
  read_hex_secret "${LEGACY_SECRETS_FILE}" WEB_SOCKET_CONNECTION_TOKEN_SECRET false
  MIGRATION_WEB_SOCKET_CONNECTION_TOKEN_SECRET_STATE="${READ_SECRET_STATE}"
  MIGRATION_WEB_SOCKET_CONNECTION_TOKEN_SECRET="${READ_SECRET_VALUE}"
  read_hex_secret "${LEGACY_SECRETS_FILE}" WEBSOCKET_GATEWAY_INTERNAL_SECRET false
  MIGRATION_WEBSOCKET_GATEWAY_INTERNAL_SECRET_STATE="${READ_SECRET_STATE}"
  MIGRATION_WEBSOCKET_GATEWAY_INTERNAL_SECRET="${READ_SECRET_VALUE}"
  read_hex_secret "${LEGACY_SECRETS_FILE}" ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY false
  MIGRATION_ASSISTANT_KEY_STATE="${READ_SECRET_STATE}"
  MIGRATION_ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY="${READ_SECRET_VALUE}"

  MIGRATION_TEMPORARY="$(mktemp "${SECRETS_DIR}/secrets.env.migrate.XXXXXX")"
  if ! (
    for REQUIRED_LEGACY_SECRET in AUTH_JWT_SECRET JWT_SECRET ENCRYPTION_SERVER_KEY PSEUDO_KEY_PARAMS_KEY VALET_TOKEN_SECRET; do
      MIGRATION_VALUE_NAME="MIGRATION_${REQUIRED_LEGACY_SECRET}"
      printf '%s=%s\n' "${REQUIRED_LEGACY_SECRET}" "${!MIGRATION_VALUE_NAME}" >> "${MIGRATION_TEMPORARY}" || exit 1
    done
    append_migrated_optional_secret "${MIGRATION_TEMPORARY}" WEB_SOCKET_CONNECTION_TOKEN_SECRET \
      "${MIGRATION_WEB_SOCKET_CONNECTION_TOKEN_SECRET_STATE}" \
      "${MIGRATION_WEB_SOCKET_CONNECTION_TOKEN_SECRET}" || exit 1
    append_migrated_optional_secret "${MIGRATION_TEMPORARY}" WEBSOCKET_GATEWAY_INTERNAL_SECRET \
      "${MIGRATION_WEBSOCKET_GATEWAY_INTERNAL_SECRET_STATE}" \
      "${MIGRATION_WEBSOCKET_GATEWAY_INTERNAL_SECRET}" || exit 1
    append_migrated_optional_secret "${MIGRATION_TEMPORARY}" ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY \
      "${MIGRATION_ASSISTANT_KEY_STATE}" "${MIGRATION_ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}" || exit 1
    chown root:root "${MIGRATION_TEMPORARY}" && chmod 0600 "${MIGRATION_TEMPORARY}" && \
      mv -Tf -- "${MIGRATION_TEMPORARY}" "${SECRETS_FILE}"
  ); then
    rm -f -- "${MIGRATION_TEMPORARY}"
    die "Could not atomically migrate legacy secrets into root-owned storage."
  fi
  validate_secret_document "${SECRETS_FILE}"
  for REQUIRED_LEGACY_SECRET in AUTH_JWT_SECRET JWT_SECRET ENCRYPTION_SERVER_KEY PSEUDO_KEY_PARAMS_KEY VALET_TOKEN_SECRET; do
    read_hex_secret "${SECRETS_FILE}" "${REQUIRED_LEGACY_SECRET}" true
    MIGRATION_VALUE_NAME="MIGRATION_${REQUIRED_LEGACY_SECRET}"
    [ "${READ_SECRET_VALUE}" = "${!MIGRATION_VALUE_NAME}" ] || \
      die "Root-owned ${REQUIRED_LEGACY_SECRET} failed post-migration verification."
  done
  verify_migrated_optional_secret "${SECRETS_FILE}" WEB_SOCKET_CONNECTION_TOKEN_SECRET \
    "${MIGRATION_WEB_SOCKET_CONNECTION_TOKEN_SECRET_STATE}" \
    "${MIGRATION_WEB_SOCKET_CONNECTION_TOKEN_SECRET}"
  verify_migrated_optional_secret "${SECRETS_FILE}" WEBSOCKET_GATEWAY_INTERNAL_SECRET \
    "${MIGRATION_WEBSOCKET_GATEWAY_INTERNAL_SECRET_STATE}" \
    "${MIGRATION_WEBSOCKET_GATEWAY_INTERNAL_SECRET}"
  verify_migrated_optional_secret "${SECRETS_FILE}" ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY \
    "${MIGRATION_ASSISTANT_KEY_STATE}" "${MIGRATION_ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}"
  log "Migrated persistent secrets into root-owned storage."
fi

CURRENT_ASSISTANT_SUBSCRIPTION_KEY=""
if [ -e "${CURRENT_HOME_ENV}" ]; then
  [ -f "${CURRENT_HOME_ENV}" ] && [ ! -L "${CURRENT_HOME_ENV}" ] || \
    die "The active home-server environment must be a regular non-symlink file."
  read_hex_secret "${CURRENT_HOME_ENV}" ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY false
  [ "${READ_SECRET_STATE}" = missing ] || CURRENT_ASSISTANT_SUBSCRIPTION_KEY="${READ_SECRET_VALUE}"
fi

if [ ! -e "${SECRETS_FILE}" ]; then
  if [ -s "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" ] || [ -s "${LEGACY_ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" ]; then
    [ -n "${CURRENT_ASSISTANT_SUBSCRIPTION_KEY}" ] || \
      die "Assistant pairing ciphertext exists but its encryption key is not recoverable. Restore the previous secrets before installing."
  fi
  ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY="${CURRENT_ASSISTANT_SUBSCRIPTION_KEY:-$(openssl rand -hex 32)}"
  NEW_SECRETS_TEMPORARY="$(mktemp "${SECRETS_DIR}/secrets.env.create.XXXXXX")"
  if ! (
    umask 077
    printf 'AUTH_JWT_SECRET=%s\n' "$(openssl rand -hex 32)" > "${NEW_SECRETS_TEMPORARY}" &&
      printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)" >> "${NEW_SECRETS_TEMPORARY}" &&
      printf 'ENCRYPTION_SERVER_KEY=%s\n' "$(openssl rand -hex 32)" >> "${NEW_SECRETS_TEMPORARY}" &&
      printf 'PSEUDO_KEY_PARAMS_KEY=%s\n' "$(openssl rand -hex 32)" >> "${NEW_SECRETS_TEMPORARY}" &&
      printf 'VALET_TOKEN_SECRET=%s\n' "$(openssl rand -hex 32)" >> "${NEW_SECRETS_TEMPORARY}" &&
      printf 'WEB_SOCKET_CONNECTION_TOKEN_SECRET=%s\n' "$(openssl rand -hex 32)" >> "${NEW_SECRETS_TEMPORARY}" &&
      printf 'WEBSOCKET_GATEWAY_INTERNAL_SECRET=%s\n' "$(openssl rand -hex 32)" >> "${NEW_SECRETS_TEMPORARY}" &&
      printf 'ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=%s\n' \
        "${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}" >> "${NEW_SECRETS_TEMPORARY}" &&
      chown root:root "${NEW_SECRETS_TEMPORARY}" && chmod 0600 "${NEW_SECRETS_TEMPORARY}" &&
      mv -Tf -- "${NEW_SECRETS_TEMPORARY}" "${SECRETS_FILE}"
  ); then
    rm -f -- "${NEW_SECRETS_TEMPORARY}"
    die "Could not atomically create root-owned persistent secrets."
  fi
  log "Wrote new secrets to ${SECRETS_FILE}"
fi

[ -f "${SECRETS_FILE}" ] && [ ! -L "${SECRETS_FILE}" ] || \
  die "Persistent secrets must be a regular non-symlink file: ${SECRETS_FILE}"
validate_secret_document "${SECRETS_FILE}"
SECRETS_MODE="$(stat -c '%a' "${SECRETS_FILE}")"
SECRETS_OWNER="$(stat -c '%u' "${SECRETS_FILE}")"
[ "${SECRETS_MODE}" = 600 ] || die "${SECRETS_FILE} must have mode 600."
[ "${SECRETS_OWNER}" = 0 ] || die "${SECRETS_FILE} must be owned by root."

persist_missing_websocket_secrets
validate_secret_document "${SECRETS_FILE}"
read_hex_secret "${SECRETS_FILE}" WEB_SOCKET_CONNECTION_TOKEN_SECRET true
read_hex_secret "${SECRETS_FILE}" WEBSOCKET_GATEWAY_INTERNAL_SECRET true

read_hex_secret "${SECRETS_FILE}" ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY false
if [ "${READ_SECRET_STATE}" = missing ]; then
  if [ -s "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" ] || [ -s "${LEGACY_ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" ]; then
    [ -n "${CURRENT_ASSISTANT_SUBSCRIPTION_KEY}" ] || \
      die "Assistant pairing ciphertext exists but its encryption key is not recoverable. Restore the previous secrets before installing."
  fi
  ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY="${CURRENT_ASSISTANT_SUBSCRIPTION_KEY:-$(openssl rand -hex 32)}"
  persist_assistant_secret "${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}"
  log "Added the internal assistant pairing key to persistent secrets."
else
  ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY="${READ_SECRET_VALUE}"
fi

if [ -n "${CURRENT_ASSISTANT_SUBSCRIPTION_KEY}" ] && \
   [ "${CURRENT_ASSISTANT_SUBSCRIPTION_KEY}" != "${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}" ] && \
   { [ -s "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" ] || [ -s "${LEGACY_ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" ]; }; then
  die "The active release and persistent secrets contain different assistant pairing keys. Restore the matching secrets before upgrading."
fi

for EMPTY_PAIRING_FILE in "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" "${LEGACY_ASSISTANT_SUBSCRIPTION_TOKEN_PATH}"; do
  if [ -f "${EMPTY_PAIRING_FILE}" ] && [ ! -s "${EMPTY_PAIRING_FILE}" ]; then
    rm -f -- "${EMPTY_PAIRING_FILE}"
  fi
done
[ ! -s "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" ] || \
  verify_pairing_store "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" "${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}"
[ ! -s "${LEGACY_ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" ] || \
  verify_pairing_store "${LEGACY_ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" "${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}"
if [ -s "${LEGACY_ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" ]; then
  if [ -s "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" ]; then
    cmp -s -- "${LEGACY_ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" || \
      die "Both legacy and durable assistant pairing stores exist with different contents; reconcile them before upgrading."
  else
    install -o "${APP_USER}" -g "${APP_USER}" -m 0600 \
      "${LEGACY_ASSISTANT_SUBSCRIPTION_TOKEN_PATH}" "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}"
    log "Migrated assistant pairing state into ${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}"
  fi
fi

# Parse the fixed generated schema as inert data instead of sourcing a writable
# file as shell code.
for SECRET_NAME in AUTH_JWT_SECRET JWT_SECRET ENCRYPTION_SERVER_KEY PSEUDO_KEY_PARAMS_KEY VALET_TOKEN_SECRET WEB_SOCKET_CONNECTION_TOKEN_SECRET WEBSOCKET_GATEWAY_INTERNAL_SECRET ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY; do
  read_hex_secret "${SECRETS_FILE}" "${SECRET_NAME}" true
  printf -v "${SECRET_NAME}" '%s' "${READ_SECRET_VALUE}"
done
if [ -e "${LEGACY_SECRETS_FILE}" ]; then
  [ -f "${LEGACY_SECRETS_FILE}" ] && [ ! -L "${LEGACY_SECRETS_FILE}" ] || \
    die "Refusing to remove a non-regular legacy secrets path: ${LEGACY_SECRETS_FILE}"
  [ "$(stat -c '%a' "${LEGACY_SECRETS_FILE}")" = 600 ] || \
    die "Refusing to remove legacy secrets unless they still have mode 600."
  LEGACY_SECRETS_OWNER="$(stat -c '%u' "${LEGACY_SECRETS_FILE}")"
  APP_UID="$(id -u "${APP_USER}")"
  [ "${LEGACY_SECRETS_OWNER}" = 0 ] || [ "${LEGACY_SECRETS_OWNER}" = "${APP_UID}" ] || \
    die "Refusing to remove legacy secrets not owned by root or ${APP_USER}."
  validate_secret_document "${LEGACY_SECRETS_FILE}"
  for LEGACY_SECRET_NAME in AUTH_JWT_SECRET JWT_SECRET ENCRYPTION_SERVER_KEY PSEUDO_KEY_PARAMS_KEY VALET_TOKEN_SECRET; do
    read_hex_secret "${SECRETS_FILE}" "${LEGACY_SECRET_NAME}" true
    CANONICAL_LEGACY_SECRET_VALUE="${READ_SECRET_VALUE}"
    read_hex_secret "${LEGACY_SECRETS_FILE}" "${LEGACY_SECRET_NAME}" true
    [ "${READ_SECRET_VALUE}" = "${CANONICAL_LEGACY_SECRET_VALUE}" ] || \
      die "Refusing to remove legacy ${LEGACY_SECRET_NAME}: it differs from root-owned storage."
  done
  for OPTIONAL_LEGACY_SECRET_NAME in WEB_SOCKET_CONNECTION_TOKEN_SECRET WEBSOCKET_GATEWAY_INTERNAL_SECRET ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY; do
    read_hex_secret "${LEGACY_SECRETS_FILE}" "${OPTIONAL_LEGACY_SECRET_NAME}" false
    if [ "${READ_SECRET_STATE}" = valid ]; then
      LEGACY_OPTIONAL_SECRET_VALUE="${READ_SECRET_VALUE}"
      read_hex_secret "${SECRETS_FILE}" "${OPTIONAL_LEGACY_SECRET_NAME}" true
      [ "${READ_SECRET_VALUE}" = "${LEGACY_OPTIONAL_SECRET_VALUE}" ] || \
        die "Refusing to remove legacy ${OPTIONAL_LEGACY_SECRET_NAME}: it differs from root-owned storage."
    fi
  done
  rm -f -- "${LEGACY_SECRETS_FILE}"
  log "Removed the obsolete app-writable legacy secrets copy."
fi

# -----------------------------------------------------------------------------
log "Writing home-server .env"
# dotenv (bin/server.ts) reads this from the home-server package dir (the service
# WorkingDirectory). sqlite + in-memory cache run without external services;
# REDIS_HOST is optional and only enables the worker WebSocket sync plane.
cat > "${HS_DIR}/.env" <<EOF
NODE_ENV=production
LOG_LEVEL=${LOG_LEVEL:-info}
SRN_DEPLOY_REVISION=${DEPLOY_COMMIT}
SRN_DEPLOY_VERSION=${SRN_DEPLOY_VERSION}
E2E_TESTING=false
PORT=3000
BIND_ADDRESS=127.0.0.1
DB_TYPE=sqlite
CACHE_TYPE=memory
DB_SQLITE_DATABASE_PATH=${DATA_DIR}/database/home_server.sqlite
FILE_UPLOAD_PATH=${DATA_DIR}/uploads
FILE_DOWNLOAD_DEADLINE_MS=${FILE_DOWNLOAD_DEADLINE_MS}
REDIS_URL=${REDIS_URL:-redis://localhost:6379}
AUTH_JWT_SECRET=${AUTH_JWT_SECRET}
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_SERVER_KEY=${ENCRYPTION_SERVER_KEY}
PSEUDO_KEY_PARAMS_KEY=${PSEUDO_KEY_PARAMS_KEY}
VALET_TOKEN_SECRET=${VALET_TOKEN_SECRET}
WEB_SOCKET_CONNECTION_TOKEN_SECRET=${WEB_SOCKET_CONNECTION_TOKEN_SECRET}
WEBSOCKET_GATEWAY_INTERNAL_SECRET=${WEBSOCKET_GATEWAY_INTERNAL_SECRET}
ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}
ASSISTANT_SUBSCRIPTION_TOKEN_PATH=${ASSISTANT_SUBSCRIPTION_TOKEN_PATH}
FILES_SERVER_URL=${PUBLIC_FILES_SERVER_URL:-http://localhost:${HTTP_PORT}/files}
SERVER_SETTINGS_PATH=${DATA_DIR}/server-settings.json
CALDAV_DATA_PATH=${DATA_DIR}/caldav
REMINDER_DELIVERY_DATA_PATH=${DATA_DIR}/reminder-delivery
COOKIE_DOMAIN=${COOKIE_DOMAIN:-}
COOKIE_SAME_SITE=${COOKIE_SAME_SITE:-Lax}
COOKIE_SECURE=${COOKIE_SECURE:-false}
TRUST_PROXY=${TRUST_PROXY:-loopback, linklocal, uniquelocal}
PUBLIC_URL=${PUBLIC_URL}
REDIS_HOST=${REDIS_HOST}
REDIS_PORT=${REDIS_PORT}
WEBSOCKET_SYNC_ENABLED=${WEBSOCKET_SYNC_ENABLED}
WEBSOCKET_SYNC_ALLOWED_ORIGINS=${WEBSOCKET_SYNC_ALLOWED_ORIGINS}
WEBSOCKET_SYNC_MAX_SOCKETS_PER_USER=${WEBSOCKET_SYNC_MAX_SOCKETS_PER_USER}
WEBSOCKET_SYNC_REDIS_KEY_PREFIX=${WEBSOCKET_SYNC_REDIS_KEY_PREFIX}
WEBSOCKET_SYNC_REDIS_OPERATION_TIMEOUT_MS=${WEBSOCKET_SYNC_REDIS_OPERATION_TIMEOUT_MS}
WEBSOCKET_SYNC_COMMAND_LEASE_TTL_MS=${WEBSOCKET_SYNC_COMMAND_LEASE_TTL_MS}
WEBSOCKET_SYNC_SOCKET_LEASE_TTL_MS=${WEBSOCKET_SYNC_SOCKET_LEASE_TTL_MS}
STANDARD_RED_FEATURES_MODE=${STANDARD_RED_FEATURES_MODE:-included}
STANDARD_RED_ENTITLEMENT_MODE=${STANDARD_RED_ENTITLEMENT_MODE:-included}
STANDARD_RED_FULL_FEATURE_DURATION_DAYS=${STANDARD_RED_FULL_FEATURE_DURATION_DAYS:-36500}
STANDARD_RED_FULL_FEATURE_FILE_UPLOAD_BYTES_LIMIT=${STANDARD_RED_FULL_FEATURE_FILE_UPLOAD_BYTES_LIMIT:--1}
EOF

# -----------------------------------------------------------------------------
log "Installing the launcher + systemd unit"
STAGED_LAUNCHER="${DEPLOY_ROOT}/.srn-launcher"
STAGED_ADMIN_LAUNCHER="${DEPLOY_ROOT}/.srn-admin-launcher"
STAGED_SERVICE_UNIT="${DEPLOY_ROOT}/.srn-service.unit"
cat > "${STAGED_LAUNCHER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${CURRENT_LINK}/server/packages/home-server"
exec env BIND_ADDRESS=127.0.0.1 "${NODE_BIN}" --require "${CURRENT_LINK}/server/.pnp.cjs" dist/bin/server.js
EOF
chmod +x "${STAGED_LAUNCHER}"

cat > "${STAGED_ADMIN_LAUNCHER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${CURRENT_LINK}/server/packages/home-server"
exec runuser -u "${APP_USER}" -- "${NODE_BIN}" "${CURRENT_LINK}/server/.yarn/releases/yarn-4.17.1.cjs" node \
  "${CURRENT_LINK}/server/packages/auth/dist/bin/srn_admin.js" "\$@"
EOF
chmod +x "${STAGED_ADMIN_LAUNCHER}"

# Stage the unit; live control files are installed only during activation.
sed "s|__APP_USER__|${APP_USER}|g; s|__WORKING_DIR__|${CURRENT_LINK}/server/packages/home-server|g; s|__LAUNCHER__|${LAUNCHER}|g; s|__DATA_DIR__|${DATA_DIR}|g" \
  "${DEPLOY_ROOT}/deploy/lxc/standard-red-notes.service" > "${STAGED_SERVICE_UNIT}"

# -----------------------------------------------------------------------------
log "Configuring nginx"
install_nginx_site() {
  local conf="$1"
  cat > "${conf}" <<EOF
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }

server {
  listen ${HTTP_PORT};
  server_name _;
  root ${WEB_ROOT};
  index index.html;

  gzip on;
  gzip_types text/plain text/css application/javascript application/json image/svg+xml;
  location = /health { access_log off; add_header Content-Type text/plain; return 200 "ok\n"; }

  location = /.well-known/srn-deployment.json {
    access_log off;
    default_type application/json;
    add_header Cache-Control "no-store" always;
    alias ${CURRENT_LINK}/.srn-deployment.json;
  }

  location /sockets {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_set_header Host \$host;
    # This nginx is the LXC public trust boundary. Discard any client-supplied
    # forwarding chain instead of letting it influence Express request.ip.
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
  }

  location ~ ^/(v1|v2|auth|subscription|healthcheck)(/|\$) {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Real-IP \$remote_addr;
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_read_timeout 300s;
  }

  location /files/ {
    rewrite ^/files(/.*)\$ \$1 break;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  # pdf.js loads the emitted .mjs worker as an ES module. Scope the MIME
  # override to that generated asset directory; do not replace mime.types.
  location ~ ^/assets/pdf/[^/]+\.mjs\$ {
    default_type application/javascript;
    try_files \$uri =404;
  }

  location / {
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-__CSP_INLINE_SCRIPT_HASH__'; script-src-attr 'self' 'unsafe-hashes' 'sha256-nIvOnptGOkcUoTPVOYWoDnWbMyGMgUTK8pMzXf87azw='; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' blob: data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:* ws: wss:; frame-src 'self' blob: https:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
    try_files \$uri \$uri/ /index.html;
  }

  location = /sandbox.html {
    add_header Content-Security-Policy "default-src 'none'; script-src 'unsafe-eval' 'sha256-EPrJb6puQWQD5nA7xTakXxjOrf6gHNhgb9Eom8L9Oe8='; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; sandbox allow-scripts" always;
    try_files /sandbox.html =404;
  }
}
EOF
}
STAGED_NGINX_SITE="${DEPLOY_ROOT}/.srn-nginx.conf"
install_nginx_site "${STAGED_NGINX_SITE}"

# Self-heal the CSP inline-script hash against the SERVED index.html — the same
# approach as app/docker/docker-entrypoint.sh, run here at install/upgrade time.
apply_csp_hash() {
  local index="${DEPLOY_ROOT}/app/packages/web/dist/index.html"
  local conf="${STAGED_NGINX_SITE}"
  [ -f "${index}" ] || { warn "index.html missing; leaving CSP fallback"; return 1; }
  local body hex b64
  body="$(awk '
    { buf = buf $0 "\n" }
    END {
      L=length(buf); clean=""; i=1
      while (i<=L) {
        if (substr(buf,i,4)=="<!--") { rest=substr(buf,i+4); j=index(rest,"-->"); if(j==0)break; i=i+4+j+2 }
        else { clean=clean substr(buf,i,1); i=i+1 }
      }
      CL=length(clean); sp=1
      while (sp<=CL) {
        seg=substr(clean,sp); p=index(seg,"<script"); if(p==0)exit 1
        abs=sp+p-1; gt=index(substr(clean,abs),">"); if(gt==0)exit 1
        tag=substr(clean,abs,gt); if(tag ~ /src/){sp=abs+gt;continue}
        bs=abs+gt; ce=index(substr(clean,bs),"</script>"); if(ce==0)exit 1
        printf "%s", substr(clean,bs,ce-1); exit 0
      }
      exit 1
    }' "${index}")" || { warn "could not extract inline script; leaving CSP fallback"; return 1; }
  [ -n "${body}" ] || return 1
  hex="$(printf '%s' "${body}" | sha256sum | awk '{print $1}')"
  printf '%s' "${hex}" | grep -Eq '^[0-9a-fA-F]{64}$' || return 1
  b64="$(printf '%s' "${hex}" | xxd -r -p | base64 | tr -d '\n')"
  sed -i "s|__CSP_INLINE_SCRIPT_HASH__|${b64}|g" "${conf}"
  log "CSP inline-script hash: sha256-${b64}"
}
apply_csp_hash || die "Could not derive the staged web CSP hash; live release was not switched."
cat > "${DEPLOY_ROOT}/.srn-nginx-test.conf" <<EOF
events {}
http {
  include /etc/nginx/mime.types;
  include ${STAGED_NGINX_SITE};
}
EOF
nginx -t -q -c "${DEPLOY_ROOT}/.srn-nginx-test.conf" || \
  die "Staged nginx configuration is invalid; live configuration was not changed."
rm -f -- "${DEPLOY_ROOT}/.srn-nginx-test.conf"

# -----------------------------------------------------------------------------
log "Health-checking and sealing the staged release"
chown -R "${APP_USER}:${APP_USER}" "${DATA_DIR}" "${HS_DIR}/.env"
release_smoke_backend "${DEPLOY_ROOT}" "${APP_USER}" "${NODE_BIN}" 120 || \
  die "Staged backend failed its health preflight; live release was not switched."
release_seal "${RELEASE_STAGE}" "${RELEASE_FINAL}" "${APP_USER}"
trap - EXIT

OLD_RELEASE="$(release_link_target "${CURRENT_LINK}" "${RELEASES_DIR}" 2>/dev/null || true)"
OLD_RELEASE_REVISION=""
OLD_RELEASE_VERSION=""
if [ -n "${OLD_RELEASE}" ]; then
  read_trusted_release_identity "${OLD_RELEASE}" || \
    die "The active release does not contain a trusted sealed deployment identity."
  OLD_RELEASE_REVISION="${TRUSTED_RELEASE_REVISION}"
  OLD_RELEASE_VERSION="${TRUSTED_RELEASE_VERSION}"
fi
atomic_install_control() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="${target}.new.$$"
  install -o root -g root -m "${mode}" "${source}" "${temporary}" || return 1
  if ! mv -Tf -- "${temporary}" "${target}"; then
    rm -f -- "${temporary}"
    return 1
  fi
}

backup_live_control() {
  local target="$1" backup
  if [ -e "${target}" ]; then
    [ -f "${target}" ] || return 1
    backup="$(mktemp)" || return 1
    cp -a -- "${target}" "${backup}" || { rm -f -- "${backup}"; return 1; }
    printf '%s\n' "${backup}"
  fi
}

restore_live_control() {
  local backup="$1" target="$2" mode="$3"
  if [ -n "${backup}" ]; then
    atomic_install_control "${backup}" "${target}" "${mode}"
  else
    rm -f -- "${target}"
  fi
}

LAUNCHER_BACKUP=""
ADMIN_LAUNCHER_BACKUP=""
SERVICE_UNIT_BACKUP=""
NGINX_BACKUP=""
cleanup_control_backups() {
  local backup
  for backup in "${LAUNCHER_BACKUP}" "${ADMIN_LAUNCHER_BACKUP}" "${SERVICE_UNIT_BACKUP}" "${NGINX_BACKUP}"; do
    [ -z "${backup}" ] || rm -f -- "${backup}"
  done
  rm -f -- "${LAUNCHER}.new.$$" "${ADMIN_LAUNCHER}.new.$$" \
    /etc/systemd/system/standard-red-notes.service.new.$$ "${NGINX_SITE}.new.$$"
}
trap cleanup_control_backups EXIT

LAUNCHER_BACKUP="$(backup_live_control "${LAUNCHER}")"
ADMIN_LAUNCHER_BACKUP="$(backup_live_control "${ADMIN_LAUNCHER}")"
SERVICE_UNIT_BACKUP="$(backup_live_control /etc/systemd/system/standard-red-notes.service)"
NGINX_BACKUP="$(backup_live_control "${NGINX_SITE}")"
SRN_SERVICE_WAS_INSTALLED=false
SRN_SERVICE_WAS_ACTIVE=false
SRN_SERVICE_WAS_ENABLED=false
NGINX_WAS_ACTIVE=false
systemctl is-active --quiet standard-red-notes.service && SRN_SERVICE_WAS_ACTIVE=true
systemctl is-enabled --quiet standard-red-notes.service && SRN_SERVICE_WAS_ENABLED=true
systemctl is-active --quiet nginx && NGINX_WAS_ACTIVE=true
[ -n "${SERVICE_UNIT_BACKUP}" ] && SRN_SERVICE_WAS_INSTALLED=true
NGINX_LINK_TARGET=""
DEFAULT_LINK_TARGET=""
[ ! -e "${NGINX_SITE_LINK}" ] || [ -L "${NGINX_SITE_LINK}" ] || \
  die "Refusing to replace non-symlink nginx site entry: ${NGINX_SITE_LINK}"
if [ -L "${NGINX_SITE_LINK}" ]; then
  NGINX_LINK_TARGET="$(readlink -- "${NGINX_SITE_LINK}")"
fi
if [ -e /etc/nginx/sites-enabled/default ] && [ ! -L /etc/nginx/sites-enabled/default ]; then
  die "Refusing to replace non-symlink nginx default site."
elif [ -L /etc/nginx/sites-enabled/default ]; then
  DEFAULT_LINK_TARGET="$(readlink -- /etc/nginx/sites-enabled/default)"
fi

restore_live_controls() {
  restore_live_control "${LAUNCHER_BACKUP}" "${LAUNCHER}" 0755
  restore_live_control "${ADMIN_LAUNCHER_BACKUP}" "${ADMIN_LAUNCHER}" 0755
  restore_live_control "${SERVICE_UNIT_BACKUP}" /etc/systemd/system/standard-red-notes.service 0644
  restore_live_control "${NGINX_BACKUP}" "${NGINX_SITE}" 0644
  if [ -n "${NGINX_LINK_TARGET}" ]; then
    ln -sfn "${NGINX_LINK_TARGET}" "${NGINX_SITE_LINK}"
  else
    rm -f -- "${NGINX_SITE_LINK}"
  fi
  if [ -n "${DEFAULT_LINK_TARGET}" ]; then
    ln -sfn "${DEFAULT_LINK_TARGET}" /etc/nginx/sites-enabled/default
  fi
}

log "Atomically activating commit ${DEPLOY_COMMIT}"
if release_activate "${RELEASE_FINAL}" "${CURRENT_LINK}" "${PREVIOUS_LINK}" "${RELEASES_DIR}" && \
  atomic_install_control "${RELEASE_FINAL}/.srn-launcher" "${LAUNCHER}" 0755 && \
  atomic_install_control "${RELEASE_FINAL}/.srn-admin-launcher" "${ADMIN_LAUNCHER}" 0755 && \
  atomic_install_control "${RELEASE_FINAL}/.srn-service.unit" /etc/systemd/system/standard-red-notes.service 0644 && \
  atomic_install_control "${RELEASE_FINAL}/.srn-nginx.conf" "${NGINX_SITE}" 0644 && \
  ln -sfn "${NGINX_SITE}" "${NGINX_SITE_LINK}" && \
  rm -f /etc/nginx/sites-enabled/default; then
  :
else
  LINKS_RESTORED=true
  if [ -n "${OLD_RELEASE}" ]; then
    if ! release_swap_current_previous "${CURRENT_LINK}" "${PREVIOUS_LINK}" "${RELEASES_DIR}"; then
      LINKS_RESTORED=false
    fi
  elif [ -L "${CURRENT_LINK}" ]; then
    unlink -- "${CURRENT_LINK}"
  fi
  restore_live_controls
  [ "${LINKS_RESTORED}" = true ] || \
    die "Activation failed and the previous release links could not be restored."
  die "Activation transaction failed; release links and nginx config were restored."
fi

if nginx -t && systemctl daemon-reload && \
  systemctl enable --now standard-red-notes.service && systemctl restart nginx && \
  wait_live_health && \
  verify_live_deployment_identity "${RELEASE_FINAL}" "${DEPLOY_COMMIT}" "${SRN_DEPLOY_VERSION}"; then
  log "Live health check passed."
else
  warn "New release was unhealthy; restoring the previous release."
  if [ -n "${OLD_RELEASE}" ]; then
    release_swap_current_previous "${CURRENT_LINK}" "${PREVIOUS_LINK}" "${RELEASES_DIR}" || \
      die "Automatic rollback could not restore the release links."
    restore_live_controls
    release_restore_service_state "${SRN_SERVICE_WAS_INSTALLED}" "${SRN_SERVICE_WAS_ENABLED}" \
      "${SRN_SERVICE_WAS_ACTIVE}" "${NGINX_WAS_ACTIVE}" || \
      die "Previous release and controls were restored, but prior service state did not recover."
    if [ "${SRN_SERVICE_WAS_ACTIVE}" = true ] && [ "${NGINX_WAS_ACTIVE}" = true ]; then
      if ! wait_live_health || \
        ! verify_live_deployment_identity "${OLD_RELEASE}" "${OLD_RELEASE_REVISION}" "${OLD_RELEASE_VERSION}"; then
        die "Previous release was restored, but its trusted deployment identity did not recover."
      fi
    fi
    die "Deployment failed its live health check; the previous release was restored."
  else
    [ -L "${CURRENT_LINK}" ] && unlink -- "${CURRENT_LINK}"
    restore_live_controls
    release_restore_service_state "${SRN_SERVICE_WAS_INSTALLED}" "${SRN_SERVICE_WAS_ENABLED}" \
      "${SRN_SERVICE_WAS_ACTIVE}" "${NGINX_WAS_ACTIVE}" || \
      die "Prior controls were restored, but prior service state did not recover."
    die "Initial deployment failed its live health check; no prior release existed."
  fi
fi
cleanup_control_backups
trap - EXIT
release_prune "${RELEASES_DIR}" "${CURRENT_LINK}" "${PREVIOUS_LINK}" || \
  warn "Deployment is healthy, but stale managed releases could not be pruned."

# -----------------------------------------------------------------------------
log "Done. Standard Red Notes is starting."
cat <<EOF

  Web UI:      http://<this-container-ip>:${HTTP_PORT}/
  API health:  curl -fsS http://127.0.0.1:${HTTP_PORT}/healthcheck/readiness

  Service:     systemctl status standard-red-notes
  Logs:        journalctl -u standard-red-notes -f
  Data dir:    ${DATA_DIR}   (sqlite DB, uploads, secrets — back this up)
  Commit:      ${DEPLOY_COMMIT}
  Rollback:    ${CURRENT_LINK}/deploy/lxc/install.sh --rollback

  First run builds the sqlite schema on boot; give it ~30-60s, then register a
  user in the web UI and persist its role locally:
    srn-admin roles grant <user> ADMIN_USER
EOF
