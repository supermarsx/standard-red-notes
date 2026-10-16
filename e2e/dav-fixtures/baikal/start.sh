#!/bin/sh
# Baikal for the DAV bridge test stack (dev/compose/docker-compose.dav-test.yml).
#
# Baikal normally asks a person to click through an install wizard before it
# serves anything. A test stack cannot do that, so this writes the two things
# the wizard would have written (the configuration file and an initialised
# SQLite database with two users), then starts the image's own entrypoint.
#
# TEST FIXTURE: every password here is published.
#
# Idempotent: a volume that already holds a configuration is left alone.
set -eu

ROOT=/var/www/baikal
CONFIG="${ROOT}/config/baikal.yaml"
DATABASE="${ROOT}/Specific/db/db.sqlite"
REALM=BaikalDAV

# Baikal's Basic backend compares md5("user:realm:password") with users.digesta1.
digest() {
  printf '%s' "$1:${REALM}:$2" | md5sum | cut -d' ' -f1
}

if [ ! -s "${CONFIG}" ]; then
  ADMIN_HASH="$(printf '%s' "admin:${REALM}:baikal-admin-fixture-pw-2Wn" | sha256sum | cut -d' ' -f1)"
  cat > "${CONFIG}" <<EOF
system:
  configured_version: '0.10.1'
  timezone: UTC
  card_enabled: false
  cal_enabled: true
  dav_auth_type: Basic
  admin_passwordhash: ${ADMIN_HASH}
  failed_access_message: 'user %u authentication failure for Baikal'
  auth_realm: ${REALM}
  base_uri: ''
  invite_from: 'noreply@baikal.invalid'
database:
  backend: sqlite
  sqlite_file: ${DATABASE}
  mysql: false
  mysql_host: ''
  mysql_dbname: ''
  mysql_username: ''
  mysql_password: ''
  encryption_key: 5d0f37ab0fb2c8c4f8f4a2a1d9d3b4c1
EOF
fi

if [ ! -s "${DATABASE}" ]; then
  sqlite3 "${DATABASE}" < "${ROOT}/Core/Resources/Db/SQLite/db.sql"
  for entry in "alice:alice-baikal-fixture-pw-8Rc" "bob:bob-baikal-fixture-pw-4Jx"; do
    name="${entry%%:*}"
    password="${entry#*:}"
    hash="$(digest "${name}" "${password}")"
    sqlite3 "${DATABASE}" \
      "INSERT INTO users (username, digesta1) VALUES ('${name}', '${hash}');" \
      "INSERT INTO principals (uri, email, displayname) VALUES ('principals/${name}', '${name}@baikal.invalid', '${name}');"
  done
fi

chown -R nginx:nginx "${ROOT}/config" "${ROOT}/Specific"

exec /docker-entrypoint.sh nginx -g 'daemon off;'
