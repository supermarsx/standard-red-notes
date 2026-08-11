#!/usr/bin/env bash
#
# Standard Red Notes - self-hosting setup script (macOS / Linux)
#
# Generates a complete .env file with securely-generated secrets, lets you
# customize the install (domain, ports, database name/user), and optionally
# brings the Docker Compose stack up.
#
# Usage:
#   ./scripts/setup.sh            # interactive
#   ./scripts/setup.sh --up       # interactive, then `docker compose up -d`
#   ./scripts/setup.sh --yes      # non-interactive, accept all defaults
#   ./scripts/setup.sh --yes --up # non-interactive + start the stack
#   ./scripts/setup.sh --yes --force-overwrite # explicitly replace an existing .env
#   ./scripts/setup.sh --generate-assistant-subscription-key # safely add the key to an existing .env
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve paths (run from anywhere; .env always lands in the repo root)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
ASSISTANT_MIGRATION_TEMPORARY=""

cleanup_assistant_migration_temporary() {
  if [ -n "$ASSISTANT_MIGRATION_TEMPORARY" ] && [ -f "$ASSISTANT_MIGRATION_TEMPORARY" ]; then
    rm -f -- "$ASSISTANT_MIGRATION_TEMPORARY"
  fi
}
trap cleanup_assistant_migration_temporary EXIT
trap 'cleanup_assistant_migration_temporary; exit 130' HUP INT TERM

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
ASSUME_YES=0
RUN_UP=0
FORCE_OVERWRITE=0
GENERATE_ASSISTANT_SUBSCRIPTION_KEY=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --up) RUN_UP=1 ;;
    --force-overwrite) FORCE_OVERWRITE=1 ;;
    --generate-assistant-subscription-key) GENERATE_ASSISTANT_SUBSCRIPTION_KEY=1 ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed -E 's/^# ?//'
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Pretty output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
  GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"
  RED="$(printf '\033[31m')"; CYAN="$(printf '\033[36m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi
info()  { printf '%s\n' "${CYAN}$*${RESET}"; }
ok()    { printf '%s\n' "${GREEN}$*${RESET}"; }
warn()  { printf '%s\n' "${YELLOW}$*${RESET}"; }
err()   { printf '%s\n' "${RED}$*${RESET}" >&2; }
title() { printf '\n%s\n' "${BOLD}$*${RESET}"; }

# ---------------------------------------------------------------------------
# Prompt helper: prompt VARNAME "Question" "default"
# Honors --yes (uses default without asking).
# ---------------------------------------------------------------------------
prompt() {
  local __var="$1" __question="$2" __default="$3" __answer
  if [ "$ASSUME_YES" -eq 1 ]; then
    printf -v "$__var" '%s' "$__default"
    return
  fi
  read -r -p "${__question} ${DIM}[${__default}]${RESET} " __answer || __answer=""
  if [ -z "$__answer" ]; then
    __answer="$__default"
  fi
  printf -v "$__var" '%s' "$__answer"
}

confirm() {
  # confirm "Question" -> returns 0 for yes
  local __question="$1" __answer
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  read -r -p "${__question} ${DIM}[y/N]${RESET} " __answer || __answer=""
  case "$__answer" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------------------
# Secret generation. 32 random bytes -> 64-char lowercase hex.
# AUTH_SERVER_ENCRYPTION_SERVER_KEY MUST be exactly 32 bytes of hex
# (auth's CrypterNode throws otherwise), so 64 hex chars is correct for all.
# Degrades gracefully across macOS and Linux.
# ---------------------------------------------------------------------------
gen_hex32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v xxd >/dev/null 2>&1; then
    head -c 32 /dev/urandom | xxd -p -c 256
  elif command -v od >/dev/null 2>&1; then
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  else
    err "No secure random generator found (need openssl, xxd, or od)."
    exit 1
  fi
}

# Read and validate the optional persisted pairing key without sourcing .env.
# Globals set: ASSISTANT_KEY_STATE (missing|valid), ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY.
read_assistant_subscription_key() {
  local line_count=0 line raw first_character last_character
  ASSISTANT_KEY_STATE="missing"
  ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=""

  while IFS= read -r line; do
    line_count=$((line_count + 1))
    raw="${line#*=}"
    ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY="$(printf '%s' "$raw" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  done < <(grep -E '^[[:space:]]*ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY[[:space:]]*=' "$ENV_FILE" || true)

  if [ "$line_count" -gt 1 ]; then
    err "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY is assigned more than once in .env. Refusing ambiguous configuration."
    exit 1
  fi
  if [ "$line_count" -eq 0 ] || [ -z "$ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY" ]; then
    ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=""
    return
  fi

  first_character="${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY:0:1}"
  last_character="${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY: -1}"
  if [ "$first_character" = '"' ] || [ "$first_character" = "'" ] || [ "$last_character" = '"' ] || [ "$last_character" = "'" ]; then
    if [ "$first_character" != "$last_character" ]; then
      err "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY has unbalanced or mismatched quotes."
      exit 1
    fi
    ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY="${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY:1:${#ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}-2}"
  fi
  if ! [[ "$ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
    err "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes)."
    exit 1
  fi
  ASSISTANT_KEY_STATE="valid"
}

assistant_pairing_probe_script='path="${ASSISTANT_SUBSCRIPTION_TOKEN_PATH:-/opt/server/packages/api-gateway/data/assistant-subscription.json}"
case "$path" in
  /opt/server/packages/api-gateway/data/*) ;;
  *) exit 42 ;;
esac
[ ! -e "$path" ] || exit 43'

assert_no_existing_assistant_pairing_data() {
  local container_ids container_id running mount_destinations probe_status use_compose_probe=0
  container_ids="$(cd "$REPO_ROOT" && $COMPOSE ps --all -q server)"
  if [ -n "$container_ids" ] && [ "$(printf '%s\n' "$container_ids" | grep -c .)" -ne 1 ]; then
    err "Multiple Compose server containers were found. Refusing to guess which pairing store is authoritative."
    exit 1
  fi

  set +e
  if [ -n "$container_ids" ]; then
    container_id="$container_ids"
    running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null)"
    if [ "$running" = "true" ]; then
      docker exec "$container_id" /bin/sh -ec "$assistant_pairing_probe_script"
      probe_status=$?
    else
      mount_destinations="$(docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "$container_id" 2>/dev/null)"
      if printf '%s\n' "$mount_destinations" | grep -Fxq '/opt/server/packages/api-gateway/data'; then
        # A current stopped container stores pairing state in server-data. Inspect
        # that same volume through a disposable no-dependencies container.
        use_compose_probe=1
      else
        set -e
        err "The stopped server container has no inspectable persistent gateway-data mount. It may contain legacy pairing data; start/recover it before setup generates a key."
        exit 1
      fi
    fi
  else
    use_compose_probe=1
  fi
  if [ "$use_compose_probe" -eq 1 ]; then
    (cd "$REPO_ROOT" && $COMPOSE run --rm --no-deps --entrypoint /bin/sh server -ec "$assistant_pairing_probe_script")
    probe_status=$?
  fi
  set -e

  case "$probe_status" in
    0) return ;;
    42)
      err "ASSISTANT_SUBSCRIPTION_TOKEN_PATH is outside the persistent gateway data directory. Refusing automatic key generation."
      ;;
    43)
      err "An assistant subscription pairing file already exists. Restore its original encryption key or unpair it before generating a replacement."
      ;;
    *)
      err "Could not prove that the persistent assistant pairing store is empty. Refusing automatic key generation."
      ;;
  esac
  exit 1
}

persist_assistant_subscription_key() {
  local backup temporary line replaced=0
  backup="${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  temporary="${ENV_FILE}.assistant-key.tmp.$$"
  if [ -e "$backup" ] || [ -e "$temporary" ]; then
    err "Refusing to overwrite an existing environment backup or migration temporary file."
    exit 1
  fi
  cp "$ENV_FILE" "$backup"
  chmod 600 "$backup"
  ASSISTANT_MIGRATION_TEMPORARY="$temporary"
  umask 077
  : > "$temporary"
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^[[:space:]]*ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY[[:space:]]*= ]]; then
      printf 'ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=%s\n' "$ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY" >> "$temporary"
      replaced=1
    else
      printf '%s\n' "$line" >> "$temporary"
    fi
  done < "$ENV_FILE"
  if [ "$replaced" -eq 0 ]; then
    printf '\n# Guided ChatGPT/Codex pairing credential encryption (32 random bytes).\n' >> "$temporary"
    printf 'ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=%s\n' "$ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY" >> "$temporary"
  fi
  mv "$temporary" "$ENV_FILE"
  ASSISTANT_MIGRATION_TEMPORARY=""
  chmod 600 "$ENV_FILE"
  ok "Added a persistent assistant subscription encryption key."
  ok "Backed up the previous .env to: ${backup}"
}

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
title "Standard Red Notes - self-hosting setup"

if ! command -v docker >/dev/null 2>&1; then
  err "Docker is not installed or not on PATH."
  err "Install Docker Desktop (macOS) or Docker Engine (Linux): https://docs.docker.com/get-docker/"
  exit 1
fi
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  err "Docker Compose v2 is not available. Update Docker Desktop, or install the compose plugin."
  exit 1
fi
ok "Found Docker and Compose (${COMPOSE})."

# ---------------------------------------------------------------------------
# Existing .env handling
# ---------------------------------------------------------------------------
BACKUP=""
if [ -f "$ENV_FILE" ]; then
  warn "An .env file already exists at: ${ENV_FILE}"
  read_assistant_subscription_key
  if [ "$GENERATE_ASSISTANT_SUBSCRIPTION_KEY" -eq 1 ]; then
    if [ "$FORCE_OVERWRITE" -eq 1 ]; then
      err "Use --generate-assistant-subscription-key separately before --force-overwrite."
      exit 2
    fi
    if [ "$ASSISTANT_KEY_STATE" = "valid" ]; then
      ok "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY is already configured; leaving .env unchanged."
    else
      ( cd "$REPO_ROOT" && $COMPOSE config --quiet )
      assert_no_existing_assistant_pairing_data
      ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY="$(gen_hex32)"
      persist_assistant_subscription_key
      read_assistant_subscription_key
      ( cd "$REPO_ROOT" && $COMPOSE config --quiet )
    fi
    if [ "$RUN_UP" -eq 1 ]; then
      ( cd "$REPO_ROOT" && $COMPOSE up -d --build )
      ok "Stack started."
    fi
    exit 0
  fi
  if [ "$FORCE_OVERWRITE" -ne 1 ]; then
    if [ "$ASSISTANT_KEY_STATE" = "missing" ]; then
      info "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY is missing; checking the persistent pairing store before generating it."
      ( cd "$REPO_ROOT" && $COMPOSE config --quiet )
      assert_no_existing_assistant_pairing_data
      ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY="$(gen_hex32)"
      persist_assistant_subscription_key
      read_assistant_subscription_key
      ( cd "$REPO_ROOT" && $COMPOSE config --quiet )
    fi
    info "Reusing the existing configuration; normal setup reruns never rotate existing secrets."
    ( cd "$REPO_ROOT" && $COMPOSE config --quiet )
    ok "Existing .env validated."
    if [ "$RUN_UP" -eq 1 ]; then
      info "Building and starting the existing stack..."
      ( cd "$REPO_ROOT" && $COMPOSE up -d --build )
      ok "Stack started."
    else
      info "Start it with: ${COMPOSE} up -d --build"
    fi
    info "Intentional rotation requires --force-overwrite. If an accidental overwrite already happened, run: npm run recover:database"
    exit 0
  fi
  if [ "$ASSISTANT_KEY_STATE" = "missing" ]; then
    err "The existing .env has no assistant subscription encryption key. Run normal setup once to add it safely before a full overwrite."
    exit 1
  fi
  BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  if [ -e "$BACKUP" ]; then
    err "Refusing to overwrite existing environment backup: ${BACKUP}"
    exit 1
  fi
  cp "$ENV_FILE" "$BACKUP"
  chmod 600 "$BACKUP"
  ok "Backed up existing .env to: ${BACKUP}"
fi

# ---------------------------------------------------------------------------
# Gather user choices
# ---------------------------------------------------------------------------
title "1) Where will this server be reached?"
info "For a plain localhost install just press Enter through these."
info "For an HTTPS deployment behind a domain, enter your domain (e.g. notes.example.com)."

prompt DOMAIN "Public domain or hostname (blank = localhost):" ""

USE_HTTPS="false"
COOKIE_SECURE="false"
COOKIE_DOMAIN=""
APP_BIND_ADDRESS="0.0.0.0"
if [ -n "$DOMAIN" ]; then
  if confirm "Is this domain served over HTTPS (recommended for real deployments)?"; then
    USE_HTTPS="true"
    COOKIE_SECURE="true"
    APP_BIND_ADDRESS="127.0.0.1"
  fi
  COOKIE_DOMAIN="$DOMAIN"
fi

title "2) Host port"
info "The public app port. The app's nginx front door"
info "proxies the API (/v1), files (/files/) and realtime websocket (/sockets)"
info "same-origin, so the API gateway and files service publish no host ports."
info "Optional profiles may bind separate development ports to host loopback."
prompt APP_PORT       "Web app port:"            "3001"

title "3) Database"
prompt MYSQL_DATABASE "Database name:" "standard_notes_db"
prompt MYSQL_USER     "Database user:" "std_notes_user"

title "4) Admin"
info "Admin access is a persisted role. Register the account after startup, then run:"
info "${COMPOSE} exec server srn-admin roles grant <user> ADMIN_USER"

title "5) Safety posture"
PUBLIC_DEFAULT="no"
[ -n "$DOMAIN" ] && PUBLIC_DEFAULT="yes"
info "Public instances get explicit rate limits, signup caps, and bounded infrastructure defaults."
info "Invite-only / approval-gated registration is safer after the first admin account exists."
prompt PUBLIC_SAFETY "Apply public-instance registration safety defaults? (yes/no):" "$PUBLIC_DEFAULT"
PUBLIC_SAFETY_NORMALIZED="$(printf '%s' "$PUBLIC_SAFETY" | tr '[:upper:]' '[:lower:]')"
case "$PUBLIC_SAFETY_NORMALIZED" in
  1|true|y|yes)
    USE_PUBLIC_SAFETY=1
    ;;
  *)
    USE_PUBLIC_SAFETY=0
    ;;
esac
if [ "$USE_PUBLIC_SAFETY" -eq 1 ]; then
  REGISTRATION_SIGNUPS_PER_IP_MAX="5"
  prompt REGISTRATION_MAX_TOTAL_ACCOUNTS "Maximum total accounts (0 = no cap):" "0"
  prompt GATE_REGISTRATION "Require invite links and admin approval immediately? This can block first-account setup. (yes/no):" "no"
else
  REGISTRATION_SIGNUPS_PER_IP_MAX="0"
  REGISTRATION_MAX_TOTAL_ACCOUNTS="0"
  GATE_REGISTRATION="no"
fi
GATE_REGISTRATION_NORMALIZED="$(printf '%s' "$GATE_REGISTRATION" | tr '[:upper:]' '[:lower:]')"
case "$GATE_REGISTRATION_NORMALIZED" in
  1|true|y|yes)
    REGISTRATION_INVITE_ONLY="true"
    REGISTRATION_APPROVAL_REQUIRED="true"
    ;;
  *)
    REGISTRATION_INVITE_ONLY="false"
    REGISTRATION_APPROVAL_REQUIRED="false"
    ;;
esac

# Derive URLs / origins from the answers. Files are served through the app
# front door's /files/ proxy, so the files URL is the app origin + /files.
if [ -n "$DOMAIN" ]; then
  SCHEME="http"; [ "$USE_HTTPS" = "true" ] && SCHEME="https"
  PUBLIC_FILES_SERVER_URL="${SCHEME}://${DOMAIN}:${APP_PORT}/files"
  PUBLIC_URL="${SCHEME}://${DOMAIN}:${APP_PORT}"
  if [ "$USE_HTTPS" = "true" ]; then
    PUBLIC_FILES_SERVER_URL="${SCHEME}://${DOMAIN}/files"
    PUBLIC_URL="${SCHEME}://${DOMAIN}"
  fi
  U2F_RP_ID="$DOMAIN"
  U2F_EXPECTED_ORIGIN="${SCHEME}://${DOMAIN}:${APP_PORT},${SCHEME}://${DOMAIN}"
else
  PUBLIC_FILES_SERVER_URL="http://localhost:${APP_PORT}/files"
  PUBLIC_URL="http://localhost:${APP_PORT}"
  U2F_RP_ID="localhost"
  U2F_EXPECTED_ORIGIN="http://localhost:${APP_PORT},http://localhost"
fi

# ---------------------------------------------------------------------------
# Generate secrets
# ---------------------------------------------------------------------------
title "Generating secrets (32 random bytes each)..."
AUTH_JWT_SECRET="$(gen_hex32)"
AUTH_SERVER_ENCRYPTION_SERVER_KEY="$(gen_hex32)"
VALET_TOKEN_SECRET="$(gen_hex32)"
AUTH_SERVER_PSEUDO_KEY_PARAMS_KEY="$(gen_hex32)"
WEBSOCKET_GATEWAY_INTERNAL_SECRET="$(gen_hex32)"
WEB_SOCKET_CONNECTION_TOKEN_SECRET="$(gen_hex32)"
MYSQL_PASSWORD="$(gen_hex32)"
MYSQL_ROOT_PASSWORD="$(gen_hex32)"
if [ -z "${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY:-}" ]; then
  ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY="$(gen_hex32)"
fi
ok "Secrets generated."

# ---------------------------------------------------------------------------
# Write .env  (KEEP IN SYNC WITH scripts/setup.ps1)
# ---------------------------------------------------------------------------
umask 077
cat > "$ENV_FILE" <<EOF
# =============================================================================
# Standard Red Notes - environment configuration
# Generated by scripts/setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
#
# DO NOT COMMIT THIS FILE. It contains secrets. (.gitignore already excludes it.)
# Keep this file safe and backed up. Normal setup reruns preserve existing
# secrets; intentional rotation can lock users out or disconnect persisted data.
# =============================================================================

# ----- Public app port --------------------------------------------------------
# The app's nginx front door proxies the API, files and websocket same-origin;
# the API gateway and files service are internal-only (no host ports). Optional
# profiles may bind development-only ports to host loopback.
APP_PORT=${APP_PORT}
# Keep the inner HTTP front door reachable only by a same-host reverse proxy.
# Direct LAN users may deliberately change this only while proxy HTTPS trust is off.
APP_BIND_ADDRESS=${APP_BIND_ADDRESS}

# ----- Database (MariaDB) ----------------------------------------------------
MYSQL_DATABASE=${MYSQL_DATABASE}
MYSQL_USER=${MYSQL_USER}
MYSQL_PASSWORD=${MYSQL_PASSWORD}
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD}

# ----- Required server secrets (the stack will not start without these) ------
# 64-char hex (32 bytes). The encryption key MUST be exactly 32 bytes of hex.
AUTH_JWT_SECRET=${AUTH_JWT_SECRET}
AUTH_SERVER_ENCRYPTION_SERVER_KEY=${AUTH_SERVER_ENCRYPTION_SERVER_KEY}
VALET_TOKEN_SECRET=${VALET_TOKEN_SECRET}

# Pseudo key-params seed. Auto-generated by the container if unset, but then it
# changes on every restart; pin it here so login key-params stay stable.
AUTH_SERVER_PSEUDO_KEY_PARAMS_KEY=${AUTH_SERVER_PSEUDO_KEY_PARAMS_KEY}

# ----- Security step-up client compatibility ---------------------------------
APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2=0.0.0
APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3=0.0.0

# ----- Realtime websocket gateway --------------------------------------------
# Shared secrets between the server and the websocket-gateway. Must match.
WEBSOCKET_GATEWAY_INTERNAL_SECRET=${WEBSOCKET_GATEWAY_INTERNAL_SECRET}
WEB_SOCKET_CONNECTION_TOKEN_SECRET=${WEB_SOCKET_CONNECTION_TOKEN_SECRET}

# ----- Domain / cookies / origins --------------------------------------------
# Empty COOKIE_DOMAIN => host-only cookie (works on localhost / any bare host/IP).
# For an HTTPS deployment behind a domain, COOKIE_DOMAIN is your domain and
# COOKIE_SECURE=true so the auth cookie is only sent over HTTPS.
COOKIE_DOMAIN=${COOKIE_DOMAIN}
COOKIE_SECURE=${COOKIE_SECURE}
PUBLIC_FILES_SERVER_URL=${PUBLIC_FILES_SERVER_URL}
PUBLIC_URL=${PUBLIC_URL}
# Trust X-Forwarded-Proto only for the HTTPS reverse-proxy mode explicitly
# selected above. Local/direct HTTP installs keep this disabled.
ENFORCE_HTTPS_FROM_PROXY=${USE_HTTPS}

# WebAuthn / hardware-key (U2F) relying party. Should match where the app is served.
AUTH_SERVER_U2F_RELYING_PARTY_ID=${U2F_RP_ID}
AUTH_SERVER_U2F_EXPECTED_ORIGIN=${U2F_EXPECTED_ORIGIN}

# ----- Analytics reports -----------------------------------------------------
# Optional analytics report recipients. This does not grant administrator access.
ADMIN_EMAILS=

# ----- Operational safety defaults ------------------------------------------
# These values make the generated install match the documented production
# posture. Tune them for larger instances, but do not remove them accidentally.
DB_CONNECTION_LIMIT=20
DB_MAX_CONNECTIONS=150
DB_MAX_QUERY_EXECUTION_TIME=45000
DB_INNODB_BUFFER_POOL_SIZE=512M
DB_MAX_ALLOWED_PACKET=128M
DB_INNODB_FLUSH_LOG_AT_TRX_COMMIT=1

CACHE_MEM_LIMIT=256m
CACHE_MAXMEMORY=192mb
CACHE_MAXMEMORY_POLICY=noeviction

HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES=50
MAX_CHUNK_BYTES=100000000
MAX_ATTACHMENT_BYTE_SIZE=5368709120

TRUST_PROXY=loopback,linklocal,uniquelocal
CORS_ORIGIN_STRICT_MODE_ENABLED=true
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_LOGIN_MAX=10
RATE_LIMIT_REGISTRATION_MAX=5
RATE_LIMIT_USER_WINDOW_SECONDS=60
RATE_LIMIT_USER_MAX=0
RATE_LIMIT_ADAPTIVE_ESCALATION=false

REGISTRATION_SIGNUPS_PER_IP_MAX=${REGISTRATION_SIGNUPS_PER_IP_MAX}
REGISTRATION_SIGNUPS_PER_IP_WINDOW_HOURS=24
REGISTRATION_SIGNUPS_PER_WEEK_MAX=0
REGISTRATION_SIGNUPS_PER_DEVICE_MAX=0
REGISTRATION_SIGNUPS_PER_DEVICE_WINDOW_HOURS=24
REGISTRATION_MAX_TOTAL_ACCOUNTS=${REGISTRATION_MAX_TOTAL_ACCOUNTS}
REGISTRATION_INVITE_ONLY=${REGISTRATION_INVITE_ONLY}
REGISTRATION_APPROVAL_REQUIRED=${REGISTRATION_APPROVAL_REQUIRED}

# =============================================================================
# Optional settings (uncomment and edit as needed). Defaults are applied by
# docker-compose.yml when these are left unset.
# =============================================================================
# LOG_LEVEL=info
# COOKIE_SAME_SITE=Lax
# COOKIE_PARTITIONED=false
#
# # Feature / entitlement mode (this fork defaults to fully-included).
# STANDARD_RED_FEATURES_MODE=included
# STANDARD_RED_ENTITLEMENT_MODE=included
# STANDARD_RED_FULL_FEATURE_FILE_UPLOAD_BYTES_LIMIT=-1
#
# # Revision history retention (0 = keep everything).
# REVISIONS_RETENTION_DAYS=0
# REVISIONS_MAX_COUNT_PER_ITEM=0
#
# # WebAuthn relying party display name.
# AUTH_SERVER_U2F_RELYING_PARTY_NAME=Standard Red Notes
#
# # Assistant / LLM proxy (optional). The "openai" provider is OpenAI-compatible
# # and also serves LM Studio, Ollama (OpenAI mode), OpenRouter, etc.
# ASSISTANT_ANTHROPIC_API_KEY=
# ASSISTANT_OPENAI_API_KEY=
# ASSISTANT_OPENAI_BASE_URL=
# ASSISTANT_OPENAI_MODEL=
# ASSISTANT_OLLAMA_URL=
# ASSISTANT_DEFAULT_PROVIDER=
# ASSISTANT_DEFAULT_MODEL=
# # Guided ChatGPT/Codex pairing. PUBLIC_URL above must stay the exact public
# # origin. This dedicated key is generated once and must never be rotated while
# # an encrypted pairing file exists.
ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}
# ASSISTANT_SUBSCRIPTION_TOKEN_PATH=/opt/server/packages/api-gateway/data/assistant-subscription.json
# ASSISTANT_CHATGPT_OAUTH_AUTHORIZE_URL=
# ASSISTANT_CHATGPT_OAUTH_TOKEN_URL=
# ASSISTANT_CHATGPT_OAUTH_CLIENT_ID=
# ASSISTANT_CHATGPT_OAUTH_REDIRECT_URI=
# ASSISTANT_CHATGPT_OAUTH_SCOPES=
# ASSISTANT_CHATGPT_OAUTH_ACCOUNT_ID_CLAIM=
# # Compatibility-only direct bearer mode for the default slot. Prefer pairing.
# ASSISTANT_OPENAI_AUTH_MODE=
# ASSISTANT_OPENAI_SUBSCRIPTION_TOKEN=
# ASSISTANT_OPENAI_SUBSCRIPTION_BASE_URL=
# ASSISTANT_OPENAI_ACCOUNT_ID=
# ASSISTANT_OPENAI_BETA=
# ASSISTANT_OPENAI_EXTRA_HEADERS=
# ASSISTANT_DAILY_REQUEST_LIMIT=0
#
# # MCP bridge (only used with: docker compose --profile mcp run --rm mcp)
# STANDARD_RED_NOTES_EMAIL=
# STANDARD_RED_NOTES_PASSWORD=
# STANDARD_RED_NOTES_ALLOW_WRITES=0
EOF

ok "Wrote ${ENV_FILE}"
chmod 600 "$ENV_FILE"
if [ -n "$BACKUP" ]; then
  warn "The complete environment was rotated. If that was accidental or startup now fails, run: npm run recover:database"
fi

# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------
title "Done!"
APP_URL="${PUBLIC_URL}"

if [ "$RUN_UP" -eq 1 ] || { [ "$ASSUME_YES" -eq 0 ] && confirm "Start the stack now with '${COMPOSE} up -d'?"; }; then
  info "Building and starting the stack (first run can take several minutes)..."
  if ! ( cd "$REPO_ROOT" && $COMPOSE up -d --build ); then
    if [ -n "$BACKUP" ]; then
      err "Startup failed after credential rotation. Recover the prior full environment with: npm run recover:database"
    fi
    exit 1
  fi
  ok "Stack started. Open: ${APP_URL}"
  info "Watch logs:  ${COMPOSE} logs -f"
  info "Stop:        ${COMPOSE} down"
else
  info "Next steps:"
  printf '  1. cd %s\n' "$REPO_ROOT"
  printf '  2. %s up -d --build\n' "$COMPOSE"
  printf '  3. Open %s\n' "$APP_URL"
fi
info "After registering an administrator: ${COMPOSE} exec server srn-admin roles grant <user> ADMIN_USER"
