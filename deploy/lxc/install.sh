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

if [ "${1:-}" = "--rollback" ]; then
  log "Switching current and previous releases"
  ACTIVE_RELEASE="$(release_link_target "${CURRENT_LINK}" "${RELEASES_DIR}")" || \
    die "Current release is not a valid managed release."
  release_swap_current_previous "${CURRENT_LINK}" "${PREVIOUS_LINK}" "${RELEASES_DIR}" || \
    die "No valid previous release is available."
  ROLLBACK_RELEASE="$(release_link_target "${CURRENT_LINK}" "${RELEASES_DIR}")"
  if install -o root -g root -m 0644 "${ROLLBACK_RELEASE}/.srn-nginx.conf" "${NGINX_SITE}" && \
    nginx -t && systemctl restart standard-red-notes.service nginx && wait_live_health; then
    log "Rollback complete."
    exit 0
  fi
  warn "Rollback target was unhealthy; restoring the release that was active."
  release_swap_current_previous "${CURRENT_LINK}" "${PREVIOUS_LINK}" "${RELEASES_DIR}" || \
    die "Rollback recovery could not restore the release links."
  install -o root -g root -m 0644 "${ACTIVE_RELEASE}/.srn-nginx.conf" "${NGINX_SITE}" || \
    die "Release links were restored, but the active nginx config could not be restored."
  if ! nginx -t || ! systemctl restart standard-red-notes.service nginx || ! wait_live_health; then
    die "Release links and config were restored, but live health did not recover."
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
release_create_stage "${SOURCE_DIR}" "${RELEASES_DIR}" "${DEPLOY_COMMIT}"
trap 'release_cleanup_stage "${RELEASE_STAGE:-}" "${RELEASES_DIR}"' EXIT
DEPLOY_ROOT="${RELEASE_STAGE}"
HS_DIR="${DEPLOY_ROOT}/server/packages/home-server"

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
BIND_ADDRESS=127.0.0.1
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
PUBLIC_URL=${PUBLIC_URL}
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

  location / {
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-__CSP_INLINE_SCRIPT_HASH__'; script-src-attr 'self' 'unsafe-hashes' 'sha256-nIvOnptGOkcUoTPVOYWoDnWbMyGMgUTK8pMzXf87azw='; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob: data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:* ws: wss:; frame-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
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
  wait_live_health; then
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
      wait_live_health || die "Previous release was restored, but its prior live health did not recover."
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
