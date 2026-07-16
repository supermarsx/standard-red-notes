#!/usr/bin/env bash
#
# =============================================================================
# Standard Red Notes — LXC / bare-metal installer (Debian/Ubuntu).
#
# Provisions the ALL-IN-ONE deployment inside a fresh Debian 12+ / Ubuntu 22.04+
# LXC *system* container (or any VM/host): installs Node + Yarn + nginx, builds
# the server + web app, configures the single-process home-server (embedded
# sqlite + in-memory cache + in-process events — NO MySQL/Redis), installs a
# systemd service for it, and points nginx at the built SPA + the API.
#
# Idempotent: safe to re-run to upgrade (re-pulls, rebuilds, restarts). Generated
# secrets are created ONCE and persisted under the data dir.
#
# Usage (inside the container, as root):
#   REPO_URL=https://github.com/<owner>/standard-red-notes.git ./install.sh
# or from an existing checkout bind-mounted / cloned at $APP_DIR:
#   ./install.sh
#
# Environment overrides (all optional):
#   REPO_URL     git URL to clone when $APP_DIR has no checkout (default: unset)
#   REPO_REF     branch/tag/commit to check out                 (default: main)
#   APP_DIR      repo checkout location        (default: /opt/standard-red-notes)
#   DATA_DIR     persistent data (sqlite+uploads+secrets)
#                                        (default: /var/lib/standard-red-notes)
#   WEB_ROOT     served SPA location   (default: /var/www/standard-red-notes/html)
#   APP_USER     service account               (default: standard-red-notes)
#   HTTP_PORT    nginx listen port                                (default: 80)
#   NODE_MAJOR   Node.js major version                            (default: 26)
# =============================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-}"
REPO_REF="${REPO_REF:-main}"
APP_DIR="${APP_DIR:-/opt/standard-red-notes}"
DATA_DIR="${DATA_DIR:-/var/lib/standard-red-notes}"
WEB_ROOT="${WEB_ROOT:-/var/www/standard-red-notes/html}"
APP_USER="${APP_USER:-standard-red-notes}"
HTTP_PORT="${HTTP_PORT:-80}"
NODE_MAJOR="${NODE_MAJOR:-26}"

HS_DIR="${APP_DIR}/server/packages/home-server"
LAUNCHER="/usr/local/bin/standard-red-notes-run"
UNIT_SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (needs to install packages + a systemd unit)."
command -v systemctl >/dev/null 2>&1 || die "systemd is required (run inside a system container, not an app container)."

# -----------------------------------------------------------------------------
log "Installing OS packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git nginx openssl python3 make g++

# -----------------------------------------------------------------------------
log "Installing Node.js ${NODE_MAJOR}.x + Yarn (Corepack 0.35.0)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" != "${NODE_MAJOR}" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
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
         "${DATA_DIR}/caldav" "${DATA_DIR}/reminder-delivery" \
         "$(dirname "${WEB_ROOT}")"

# -----------------------------------------------------------------------------
log "Fetching source into ${APP_DIR}"
if [ -d "${APP_DIR}/.git" ]; then
  git -C "${APP_DIR}" fetch --all --tags --prune
  git -C "${APP_DIR}" checkout "${REPO_REF}"
  git -C "${APP_DIR}" pull --ff-only origin "${REPO_REF}" || true
elif [ -f "${APP_DIR}/server/packages/home-server/package.json" ]; then
  log "Using existing (non-git) checkout at ${APP_DIR}"
elif [ -n "${REPO_URL}" ]; then
  git clone --branch "${REPO_REF}" "${REPO_URL}" "${APP_DIR}"
else
  die "No checkout at ${APP_DIR} and REPO_URL is unset. Set REPO_URL=<git url> or place the repo at ${APP_DIR}."
fi

# -----------------------------------------------------------------------------
log "Building the server workspace (home-server)"
( cd "${APP_DIR}/server" && CI=true yarn install --immutable && CI=true yarn build )

log "Building the web app bundle"
(
  cd "${APP_DIR}/app"
  printf -- '--ignore-engines true\n' > "${HOME:-/root}/.yarnrc"
  CI=true yarn workspaces focus @standardnotes/web
  CI=true NODE_OPTIONS=--no-deprecation yarn build:web
)

log "Publishing SPA to ${WEB_ROOT}"
rm -rf "${WEB_ROOT}"
mkdir -p "${WEB_ROOT}"
cp -a "${APP_DIR}/app/packages/web/dist/." "${WEB_ROOT}/"

log "Applying sqlite migration compatibility shim"
# The server's sqlite migrations were authored MySQL-first (double-quoted SQL
# string literals) and fail under better-sqlite3's DQS-off SQLite. Rewrite the
# compiled sqlite migrations in place so the instance boots. Idempotent.
node "${APP_DIR}/server/docker/single/fix-sqlite-migrations.js" "${APP_DIR}/server/packages"

# -----------------------------------------------------------------------------
log "Generating / loading persistent secrets"
SECRETS_FILE="${DATA_DIR}/secrets.env"
if [ ! -f "${SECRETS_FILE}" ]; then
  umask 077
  {
    echo "AUTH_JWT_SECRET=$(openssl rand -hex 32)"
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "ENCRYPTION_SERVER_KEY=$(openssl rand -hex 32)"
    echo "PSEUDO_KEY_PARAMS_KEY=$(openssl rand -hex 32)"
    echo "VALET_TOKEN_SECRET=$(openssl rand -hex 32)"
  } > "${SECRETS_FILE}"
  log "Wrote new secrets to ${SECRETS_FILE}"
fi
# shellcheck disable=SC1090
. "${SECRETS_FILE}"

# -----------------------------------------------------------------------------
log "Writing home-server .env"
# dotenv (bin/server.ts) reads this from the home-server package dir (the service
# WorkingDirectory). sqlite + in-memory cache => zero external services.
cat > "${HS_DIR}/.env" <<EOF
NODE_ENV=production
LOG_LEVEL=${LOG_LEVEL:-info}
E2E_TESTING=false
PORT=3000
DB_TYPE=sqlite
CACHE_TYPE=memory
DB_SQLITE_DATABASE_PATH=${DATA_DIR}/database/home_server.sqlite
FILE_UPLOAD_PATH=${DATA_DIR}/uploads
REDIS_URL=${REDIS_URL:-redis://localhost:6379}
AUTH_JWT_SECRET=${AUTH_JWT_SECRET}
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_SERVER_KEY=${ENCRYPTION_SERVER_KEY}
PSEUDO_KEY_PARAMS_KEY=${PSEUDO_KEY_PARAMS_KEY}
VALET_TOKEN_SECRET=${VALET_TOKEN_SECRET}
FILES_SERVER_URL=${PUBLIC_FILES_SERVER_URL:-http://localhost:${HTTP_PORT}/files}
SERVER_SETTINGS_PATH=${DATA_DIR}/server-settings.json
CALDAV_DATA_PATH=${DATA_DIR}/caldav
REMINDER_DELIVERY_DATA_PATH=${DATA_DIR}/reminder-delivery
COOKIE_DOMAIN=${COOKIE_DOMAIN:-}
COOKIE_SAME_SITE=${COOKIE_SAME_SITE:-Lax}
COOKIE_SECURE=${COOKIE_SECURE:-false}
TRUST_PROXY=${TRUST_PROXY:-loopback, linklocal, uniquelocal}
STANDARD_RED_FEATURES_MODE=${STANDARD_RED_FEATURES_MODE:-included}
STANDARD_RED_ENTITLEMENT_MODE=${STANDARD_RED_ENTITLEMENT_MODE:-included}
STANDARD_RED_FULL_FEATURE_DURATION_DAYS=${STANDARD_RED_FULL_FEATURE_DURATION_DAYS:-36500}
STANDARD_RED_FULL_FEATURE_FILE_UPLOAD_BYTES_LIMIT=${STANDARD_RED_FULL_FEATURE_FILE_UPLOAD_BYTES_LIMIT:--1}
ADMIN_EMAILS=${ADMIN_EMAILS:-}
EOF

# -----------------------------------------------------------------------------
log "Installing the launcher + systemd unit"
cat > "${LAUNCHER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${HS_DIR}"
exec "${NODE_BIN}" --require "${APP_DIR}/server/.pnp.cjs" dist/bin/server.js
EOF
chmod +x "${LAUNCHER}"

# Install the unit, templating the user in.
sed "s|__APP_USER__|${APP_USER}|g; s|__WORKING_DIR__|${HS_DIR}|g; s|__LAUNCHER__|${LAUNCHER}|g" \
  "${UNIT_SRC_DIR}/standard-red-notes.service" > /etc/systemd/system/standard-red-notes.service

# -----------------------------------------------------------------------------
log "Configuring nginx"
install_nginx_site() {
  local conf="/etc/nginx/sites-available/standard-red-notes.conf"
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

  location /sockets {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
  }

  location ~ ^/(v1|v2|auth|subscription|healthcheck)(/|\$) {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
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
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  location / {
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-__CSP_INLINE_SCRIPT_HASH__'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob: data:; connect-src 'self' ws: wss:; frame-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
    try_files \$uri \$uri/ /index.html;
  }
}
EOF
  ln -sf "${conf}" /etc/nginx/sites-enabled/standard-red-notes.conf
  rm -f /etc/nginx/sites-enabled/default
}
install_nginx_site

# Self-heal the CSP inline-script hash against the SERVED index.html — the same
# approach as app/docker/docker-entrypoint.sh, run here at install/upgrade time.
apply_csp_hash() {
  local index="${WEB_ROOT}/index.html"
  local conf="/etc/nginx/sites-available/standard-red-notes.conf"
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
  sed -i "s|'sha256-[A-Za-z0-9+/=_]*'|'sha256-${b64}'|" "${conf}"
  log "CSP inline-script hash: sha256-${b64}"
}
if ! apply_csp_hash; then
  warn "Falling back to 'unsafe-inline' for script-src (app still boots)."
  sed -i "s|'sha256-[A-Za-z0-9+/=_]*'|'unsafe-inline'|" \
    /etc/nginx/sites-available/standard-red-notes.conf || true
fi

# -----------------------------------------------------------------------------
log "Setting ownership + starting services"
chown -R "${APP_USER}:${APP_USER}" "${DATA_DIR}" "${HS_DIR}/.env"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}" 2>/dev/null || true

nginx -t
systemctl daemon-reload
systemctl enable --now standard-red-notes.service
systemctl restart nginx

# -----------------------------------------------------------------------------
log "Done. Standard Red Notes is starting."
cat <<EOF

  Web UI:      http://<this-container-ip>:${HTTP_PORT}/
  API health:  curl -fsS http://127.0.0.1:${HTTP_PORT}/healthcheck

  Service:     systemctl status standard-red-notes
  Logs:        journalctl -u standard-red-notes -f
  Data dir:    ${DATA_DIR}   (sqlite DB, uploads, secrets — back this up)

  First run builds the sqlite schema on boot; give it ~30-60s, then register a
  user in the web UI. Grant admin by setting ADMIN_EMAILS in
  ${HS_DIR}/.env and: systemctl restart standard-red-notes
EOF
