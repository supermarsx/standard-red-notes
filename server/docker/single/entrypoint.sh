#!/bin/sh
set -eu

# =============================================================================
# Standard Red Notes — ALL-IN-ONE single container entrypoint (PID 1).
#
# 1. Ensure the persistent data dirs exist (sqlite DB + uploads live on /data).
# 2. Generate (or load) per-instance secrets, PERSISTED to /data so they stay
#    stable across restarts — changing them would invalidate existing sessions
#    and MFA/encryption. Any secret supplied via the environment wins on first
#    boot and is persisted.
# 3. Write the home-server .env the single-process backend reads (dotenv), with
#    sqlite + in-memory cache + in-process events forced on — no external DB,
#    Redis or SNS/SQS. This mirrors the CI-proven home-server env
#    (server/.github/workflows/e2e-home-server.yml).
# 4. Run the app's CSP self-heal / runtime-config templating (reused VERBATIM
#    from app/docker/docker-entrypoint.sh) against the served index.html + nginx
#    conf, so the served CSP inline-script hash matches the served script.
# 5. Hand off to supervisord, which runs the home-server + nginx.
# =============================================================================

DATA_DIR="${SRN_DATA_DIR:-/data}"
HOME_SERVER_DIR="/opt/server/packages/home-server"
ENV_FILE="${HOME_SERVER_DIR}/.env"
SECRETS_FILE="${DATA_DIR}/secrets.env"

mkdir -p "${DATA_DIR}/database" "${DATA_DIR}/uploads" "${DATA_DIR}/caldav" "${DATA_DIR}/reminder-delivery"

# --- 2. Secrets: persist a stable set per instance -------------------------
if [ ! -f "${SECRETS_FILE}" ]; then
  # `:=` keeps any value supplied via the environment; otherwise generate one.
  # openssl rand -hex 32 => 64 hex chars = 32 bytes, which is exactly what the
  # auth CrypterNode requires for ENCRYPTION_SERVER_KEY.
  : "${AUTH_JWT_SECRET:=$(openssl rand -hex 32)}"
  : "${JWT_SECRET:=$(openssl rand -hex 32)}"
  : "${ENCRYPTION_SERVER_KEY:=$(openssl rand -hex 32)}"
  : "${PSEUDO_KEY_PARAMS_KEY:=$(openssl rand -hex 32)}"
  : "${VALET_TOKEN_SECRET:=$(openssl rand -hex 32)}"
  umask 077
  cat > "${SECRETS_FILE}" <<EOF
AUTH_JWT_SECRET=${AUTH_JWT_SECRET}
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_SERVER_KEY=${ENCRYPTION_SERVER_KEY}
PSEUDO_KEY_PARAMS_KEY=${PSEUDO_KEY_PARAMS_KEY}
VALET_TOKEN_SECRET=${VALET_TOKEN_SECRET}
EOF
  echo "[entrypoint] generated per-instance secrets at ${SECRETS_FILE}"
fi
# shellcheck disable=SC1090
. "${SECRETS_FILE}"

# --- 3. Write the home-server .env -----------------------------------------
# Helper: append KEY=VALUE only when VALUE is non-empty, so operators can leave
# any optional feature var unset and it simply falls back to the code default.
: > "${ENV_FILE}"
put() { printf '%s=%s\n' "$1" "$2" >> "${ENV_FILE}"; }
put_opt() { [ -n "${2:-}" ] && printf '%s=%s\n' "$1" "$2" >> "${ENV_FILE}" || true; }

put NODE_ENV production
put LOG_LEVEL "${LOG_LEVEL:-info}"
put E2E_TESTING false
put PORT 3000
put APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2 "${APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2:-0.0.0}"
put APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3 "${APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3:-0.0.0}"

# Minimal dependency footprint: embedded sqlite + in-memory cache + in-process
# events. (HomeServer.ts also forces these, but we set them explicitly so the
# generated .env is self-documenting.)
put DB_TYPE sqlite
put CACHE_TYPE memory
put DB_SQLITE_DATABASE_PATH "${DATA_DIR}/database/home_server.sqlite"
put FILE_UPLOAD_PATH "${DATA_DIR}/uploads"
# Required as a config string by some services' bootstrap even under
# CACHE_TYPE=memory (the in-memory cache adapter is used; no Redis is contacted).
# Matches the home-server CI env (e2e-home-server.yml).
put REDIS_URL "${REDIS_URL:-redis://localhost:6379}"

# Secrets (loaded above).
put AUTH_JWT_SECRET "${AUTH_JWT_SECRET}"
put JWT_SECRET "${JWT_SECRET}"
put ENCRYPTION_SERVER_KEY "${ENCRYPTION_SERVER_KEY}"
put PSEUDO_KEY_PARAMS_KEY "${PSEUDO_KEY_PARAMS_KEY}"
put VALET_TOKEN_SECRET "${VALET_TOKEN_SECRET}"

# Public URL the browser uses to reach the files service, served same-origin
# through nginx at /files. Defaults to this container's published origin.
put FILES_SERVER_URL "${PUBLIC_FILES_SERVER_URL:-http://localhost:${APP_PORT:-3001}/files}"

# Persist admin overrides + feature JSON stores on the data volume. Honor an
# explicit operator path; persistence then requires mounting that path too.
put SERVER_SETTINGS_PATH "${SERVER_SETTINGS_PATH:-${DATA_DIR}/server-settings.json}"
put CALDAV_DATA_PATH "${DATA_DIR}/caldav"
put REMINDER_DELIVERY_DATA_PATH "${DATA_DIR}/reminder-delivery"

# Cookies: defaults suit an http://localhost self-host (host-only cookie).
put COOKIE_DOMAIN "${COOKIE_DOMAIN:-}"
put COOKIE_SAME_SITE "${COOKIE_SAME_SITE:-Lax}"
put COOKIE_SECURE "${COOKIE_SECURE:-false}"

# Optional passthroughs — appended only when set (see put_opt).
put_opt TRUST_PROXY "${TRUST_PROXY:-}"
put_opt CORS_ORIGIN_STRICT_MODE_ENABLED "${CORS_ORIGIN_STRICT_MODE_ENABLED:-}"
put_opt CORS_ALLOWED_ORIGINS "${CORS_ALLOWED_ORIGINS:-}"
put_opt RATE_LIMIT_ENABLED "${RATE_LIMIT_ENABLED:-}"
put_opt RATE_LIMIT_WINDOW_SECONDS "${RATE_LIMIT_WINDOW_SECONDS:-}"
put_opt RATE_LIMIT_LOGIN_MAX "${RATE_LIMIT_LOGIN_MAX:-}"
put_opt RATE_LIMIT_REGISTRATION_MAX "${RATE_LIMIT_REGISTRATION_MAX:-}"
put_opt SHARED_SERVER_ACCESS_KEY "${SHARED_SERVER_ACCESS_KEY:-}"
put_opt SHARED_SERVER_ACCESS_KEY_MODE "${SHARED_SERVER_ACCESS_KEY_MODE:-}"
put_opt STANDARD_RED_FEATURES_MODE "${STANDARD_RED_FEATURES_MODE:-}"
put_opt STANDARD_RED_ENTITLEMENT_MODE "${STANDARD_RED_ENTITLEMENT_MODE:-}"
put_opt STANDARD_RED_FULL_FEATURE_DURATION_DAYS "${STANDARD_RED_FULL_FEATURE_DURATION_DAYS:-}"
put_opt STANDARD_RED_FULL_FEATURE_FILE_UPLOAD_BYTES_LIMIT "${STANDARD_RED_FULL_FEATURE_FILE_UPLOAD_BYTES_LIMIT:-}"
put_opt REVISIONS_RETENTION_DAYS "${REVISIONS_RETENTION_DAYS:-}"
put_opt REVISIONS_MAX_COUNT_PER_ITEM "${REVISIONS_MAX_COUNT_PER_ITEM:-}"
put_opt ASSISTANT_ANTHROPIC_API_KEY "${ASSISTANT_ANTHROPIC_API_KEY:-}"
put_opt ASSISTANT_OPENAI_API_KEY "${ASSISTANT_OPENAI_API_KEY:-}"
put_opt ASSISTANT_OPENAI_BASE_URL "${ASSISTANT_OPENAI_BASE_URL:-}"
put_opt ASSISTANT_OPENAI_MODEL "${ASSISTANT_OPENAI_MODEL:-}"
put_opt ASSISTANT_OLLAMA_URL "${ASSISTANT_OLLAMA_URL:-}"
put_opt ASSISTANT_DEFAULT_PROVIDER "${ASSISTANT_DEFAULT_PROVIDER:-}"
put_opt ASSISTANT_DEFAULT_MODEL "${ASSISTANT_DEFAULT_MODEL:-}"
put_opt ASSISTANT_DAILY_REQUEST_LIMIT "${ASSISTANT_DAILY_REQUEST_LIMIT:-}"
put_opt ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY "${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY:-}"
put ASSISTANT_SUBSCRIPTION_TOKEN_PATH "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH:-${DATA_DIR}/assistant-subscription.json}"
put_opt ASSISTANT_CHATGPT_OAUTH_AUTHORIZE_URL "${ASSISTANT_CHATGPT_OAUTH_AUTHORIZE_URL:-}"
put_opt ASSISTANT_CHATGPT_OAUTH_TOKEN_URL "${ASSISTANT_CHATGPT_OAUTH_TOKEN_URL:-}"
put_opt ASSISTANT_CHATGPT_OAUTH_CLIENT_ID "${ASSISTANT_CHATGPT_OAUTH_CLIENT_ID:-}"
put_opt ASSISTANT_CHATGPT_OAUTH_REDIRECT_URI "${ASSISTANT_CHATGPT_OAUTH_REDIRECT_URI:-}"
put_opt ASSISTANT_CHATGPT_OAUTH_SCOPES "${ASSISTANT_CHATGPT_OAUTH_SCOPES:-}"
put_opt ASSISTANT_CHATGPT_OAUTH_ACCOUNT_ID_CLAIM "${ASSISTANT_CHATGPT_OAUTH_ACCOUNT_ID_CLAIM:-}"
put_opt ASSISTANT_OPENAI_AUTH_MODE "${ASSISTANT_OPENAI_AUTH_MODE:-}"
put_opt ASSISTANT_OPENAI_SUBSCRIPTION_TOKEN "${ASSISTANT_OPENAI_SUBSCRIPTION_TOKEN:-}"
put_opt ASSISTANT_OPENAI_SUBSCRIPTION_BASE_URL "${ASSISTANT_OPENAI_SUBSCRIPTION_BASE_URL:-}"
put_opt ASSISTANT_OPENAI_ACCOUNT_ID "${ASSISTANT_OPENAI_ACCOUNT_ID:-}"
put_opt ASSISTANT_OPENAI_BETA "${ASSISTANT_OPENAI_BETA:-}"
put_opt ASSISTANT_OPENAI_EXTRA_HEADERS "${ASSISTANT_OPENAI_EXTRA_HEADERS:-}"
put_opt OCR_SERVER_ENABLED "${OCR_SERVER_ENABLED:-}"
put_opt OCR_SERVER_DEFAULT_LANGUAGE "${OCR_SERVER_DEFAULT_LANGUAGE:-}"
put_opt UPDATE_CHECK_URL "${UPDATE_CHECK_URL:-}"
put_opt UPDATE_CHECK_CURRENT_VERSION "${UPDATE_CHECK_CURRENT_VERSION:-}"
put_opt PUBLIC_URL "${PUBLIC_URL:-}"
put_opt WORKFLOWS_ENABLED "${WORKFLOWS_ENABLED:-}"
put_opt WORKFLOWS_PUBLIC_URL "${WORKFLOWS_PUBLIC_URL:-}"

echo "[entrypoint] wrote ${ENV_FILE} (DB=sqlite, cache=memory, data=${DATA_DIR})"

# --- 4. App runtime-config templating + CSP inline-script self-heal ---------
# Reuse the app image's entrypoint UNMODIFIED. It rewrites window.* runtime flags
# (OCR_ENABLED / OCR_DEFAULT_LANGUAGE / SYNC_SERVER) in the served index.html,
# then recomputes and substitutes the CSP inline-script sha256 in the served
# nginx conf so the two always match. It operates on the standard paths
# (/usr/share/nginx/html/index.html and /etc/nginx/conf.d/default.conf).
if [ -f /usr/local/bin/csp-runtime-config.sh ]; then
  sh /usr/local/bin/csp-runtime-config.sh || \
    echo "[entrypoint] WARNING: CSP/runtime-config templating reported a problem (app still boots)." >&2
fi

# --- 5. Hand off to supervisord --------------------------------------------
exec supervisord -c /etc/supervisord.conf
