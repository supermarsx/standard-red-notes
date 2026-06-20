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
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve paths (run from anywhere; .env always lands in the repo root)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
ASSUME_YES=0
RUN_UP=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --up) RUN_UP=1 ;;
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
if [ -f "$ENV_FILE" ]; then
  warn "An .env file already exists at: ${ENV_FILE}"
  if ! confirm "Overwrite it? A timestamped backup will be made first."; then
    err "Aborted. Existing .env left untouched."
    exit 1
  fi
  BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  cp "$ENV_FILE" "$BACKUP"
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
if [ -n "$DOMAIN" ]; then
  if confirm "Is this domain served over HTTPS (recommended for real deployments)?"; then
    USE_HTTPS="true"
    COOKIE_SECURE="true"
  fi
  COOKIE_DOMAIN="$DOMAIN"
fi

title "2) Host ports"
info "These are the ports published on the host machine."
prompt APP_PORT       "Web app port:"            "3001"
prompt SERVER_PORT    "API gateway port:"        "3000"
prompt FILES_PORT     "Files service port:"      "3125"
prompt WEBSOCKET_PORT "Realtime websocket port:" "3106"

title "3) Database"
prompt MYSQL_DATABASE "Database name:" "standard_notes_db"
prompt MYSQL_USER     "Database user:" "std_notes_user"

title "4) Admin"
info "Comma-separated emails granted the in-app Admin panel (optional)."
prompt ADMIN_EMAILS "Admin email(s):" ""

# Derive URLs / origins from the answers
if [ -n "$DOMAIN" ]; then
  SCHEME="http"; [ "$USE_HTTPS" = "true" ] && SCHEME="https"
  PUBLIC_FILES_SERVER_URL="${SCHEME}://${DOMAIN}:${FILES_PORT}"
  U2F_RP_ID="$DOMAIN"
  U2F_EXPECTED_ORIGIN="${SCHEME}://${DOMAIN}:${APP_PORT},${SCHEME}://${DOMAIN}"
else
  PUBLIC_FILES_SERVER_URL="http://localhost:${FILES_PORT}"
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
# Re-run scripts/setup.sh to regenerate. Changing the secrets below after users
# exist will lock people out, so keep this file safe and backed up.
# =============================================================================

# ----- Host ports (published on the host machine) ----------------------------
APP_PORT=${APP_PORT}
SERVER_PORT=${SERVER_PORT}
FILES_PORT=${FILES_PORT}
WEBSOCKET_PORT=${WEBSOCKET_PORT}

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

# WebAuthn / hardware-key (U2F) relying party. Should match where the app is served.
AUTH_SERVER_U2F_RELYING_PARTY_ID=${U2F_RP_ID}
AUTH_SERVER_U2F_EXPECTED_ORIGIN=${U2F_EXPECTED_ORIGIN}

# ----- Admin -----------------------------------------------------------------
# Comma-separated emails granted the in-app Admin panel and /admin endpoints.
ADMIN_EMAILS=${ADMIN_EMAILS}

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
# ASSISTANT_DAILY_REQUEST_LIMIT=0
#
# # MCP bridge (only used with: docker compose --profile mcp run --rm mcp)
# STANDARD_RED_NOTES_EMAIL=
# STANDARD_RED_NOTES_PASSWORD=
# STANDARD_RED_NOTES_ALLOW_WRITES=0
EOF

ok "Wrote ${ENV_FILE}"

# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------
title "Done!"
APP_URL="http://localhost:${APP_PORT}"
[ -n "$DOMAIN" ] && { SCHEME="http"; [ "$USE_HTTPS" = "true" ] && SCHEME="https"; APP_URL="${SCHEME}://${DOMAIN}:${APP_PORT}"; }

if [ "$RUN_UP" -eq 1 ] || { [ "$ASSUME_YES" -eq 0 ] && confirm "Start the stack now with '${COMPOSE} up -d'?"; }; then
  info "Building and starting the stack (first run can take several minutes)..."
  ( cd "$REPO_ROOT" && $COMPOSE up -d --build )
  ok "Stack started. Open: ${APP_URL}"
  info "Watch logs:  ${COMPOSE} logs -f"
  info "Stop:        ${COMPOSE} down"
else
  info "Next steps:"
  printf '  1. cd %s\n' "$REPO_ROOT"
  printf '  2. %s up -d --build\n' "$COMPOSE"
  printf '  3. Open %s\n' "$APP_URL"
fi
