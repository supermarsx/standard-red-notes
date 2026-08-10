#!/usr/bin/env bash
# Release-directory primitives used by install.sh. This file is sourced after
# install.sh enables `set -euo pipefail`; it does not perform deployment alone.

release_is_within() {
  case "$1" in
    "$2"/*) return 0 ;;
    *) return 1 ;;
  esac
}

release_link_target() {
  local link="$1" releases="$2" target
  [ -L "${link}" ] || return 1
  target="$(readlink -f -- "${link}")" || return 1
  release_is_within "${target}" "${releases}" || return 1
  [ -f "${target}/.srn-release" ] || return 1
  printf '%s\n' "${target}"
}

release_atomic_link() {
  local target="$1" link="$2" temporary
  temporary="${link}.new.$$"
  [ -d "${target}" ] || return 1
  [ ! -e "${temporary}" ] && [ ! -L "${temporary}" ] || return 1
  ln -s -- "${target}" "${temporary}"
  mv -Tf -- "${temporary}" "${link}"
}

release_create_stage() {
  local source="$1" releases="$2" commit="$3" release_id
  release_id="${commit}-$(date -u +%Y%m%d%H%M%S)-$$"
  RELEASE_STAGE="${releases}/.${release_id}.staging"
  RELEASE_FINAL="${releases}/${release_id}"
  [ ! -e "${RELEASE_STAGE}" ] && [ ! -e "${RELEASE_FINAL}" ] || return 1
  mkdir -p "${releases}"
  mkdir -m 0755 "${RELEASE_STAGE}"
  git -C "${source}" archive --format=tar "${commit}" | tar -xf - -C "${RELEASE_STAGE}"
}

release_smoke_backend() (
  local release="$1" app_user="$2" node_bin="$3" timeout="$4"
  local scratch port log_file pid="" elapsed=0
  scratch="${release}/.preflight"
  trap '[ -z "${pid}" ] || { kill "${pid}" >/dev/null 2>&1 || true; wait "${pid}" >/dev/null 2>&1 || true; }' EXIT INT TERM
  mkdir -p "${scratch}/database" "${scratch}/uploads" "${scratch}/caldav" \
    "${scratch}/reminder-delivery"
  chown -R "${app_user}:${app_user}" "${scratch}"
  port="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
  log_file="${scratch}/server.log"
  runuser -u "${app_user}" -- env -C "${release}/server/packages/home-server" \
    NODE_ENV=production PORT="${port}" BIND_ADDRESS=127.0.0.1 DB_TYPE=sqlite CACHE_TYPE=memory \
    DB_SQLITE_DATABASE_PATH="${scratch}/database/home_server.sqlite" \
    FILE_UPLOAD_PATH="${scratch}/uploads" \
    SERVER_SETTINGS_PATH="${scratch}/server-settings.json" \
    CALDAV_DATA_PATH="${scratch}/caldav" \
    REMINDER_DELIVERY_DATA_PATH="${scratch}/reminder-delivery" \
    "${node_bin}" --require "${release}/server/.pnp.cjs" \
      "${release}/server/packages/home-server/dist/bin/server.js" >"${log_file}" 2>&1 &
  pid="$!"
  while [ "${elapsed}" -lt "${timeout}" ]; do
    if curl --fail --silent --show-error --max-time 3 \
      "http://127.0.0.1:${port}/healthcheck/readiness" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" >/dev/null 2>&1 || true
      pid=""
      rm -rf -- "${scratch}"
      return 0
    fi
    if ! kill -0 "${pid}" >/dev/null 2>&1; then
      tail -n 80 "${log_file}" >&2 || true
      wait "${pid}" >/dev/null 2>&1 || true
      pid=""
      return 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  kill "${pid}" >/dev/null 2>&1 || true
  wait "${pid}" >/dev/null 2>&1 || true
  pid=""
  tail -n 80 "${log_file}" >&2 || true
  return 1
)

release_seal() {
  local stage="$1" final="$2" app_user="$3"
  printf 'commit=%s\n' "${DEPLOY_COMMIT}" > "${stage}/.srn-release"
  chown -R root:root "${stage}"
  chown "root:${app_user}" "${stage}/server/packages/home-server/.env"
  chmod -R a-w "${stage}"
  chmod 0640 "${stage}/server/packages/home-server/.env"
  mv -- "${stage}" "${final}"
}

release_activate() {
  local final="$1" current="$2" previous="$3" releases="$4" old=""
  if [ -e "${current}" ] || [ -L "${current}" ]; then
    old="$(release_link_target "${current}" "${releases}")" || return 1
    release_atomic_link "${old}" "${previous}"
  fi
  release_atomic_link "${final}" "${current}"
}

release_swap_current_previous() {
  local current="$1" previous="$2" releases="$3" active rollback
  local current_new="${current}.new.$$" previous_new="${previous}.new.$$"
  active="$(release_link_target "${current}" "${releases}")" || return 1
  rollback="$(release_link_target "${previous}" "${releases}")" || return 1
  [ "${active}" != "${rollback}" ] || return 1
  [ ! -e "${current_new}" ] && [ ! -L "${current_new}" ] || return 1
  [ ! -e "${previous_new}" ] && [ ! -L "${previous_new}" ] || return 1
  ln -s -- "${rollback}" "${current_new}" || return 1
  if ! ln -s -- "${active}" "${previous_new}"; then
    rm -f -- "${current_new}"
    return 1
  fi
  if ! mv -Tf -- "${current_new}" "${current}"; then
    rm -f -- "${current_new}" "${previous_new}"
    return 1
  fi
  if ! mv -Tf -- "${previous_new}" "${previous}"; then
    rm -f -- "${previous_new}"
    release_atomic_link "${active}" "${current}" || return 2
    return 1
  fi
}

release_cleanup_stage() {
  local stage="$1" releases="$2" resolved
  [ -n "${stage}" ] && [ -d "${stage}" ] || return 0
  resolved="$(readlink -f -- "${stage}")" || return 0
  release_is_within "${resolved}" "${releases}" || return 1
  case "$(basename "${resolved}")" in
    .*\.staging) rm -rf -- "${resolved}" ;;
    *) return 1 ;;
  esac
}

release_prune() {
  local releases="$1" current="$2" previous="$3" candidate
  current="$(release_link_target "${current}" "${releases}")" || return 1
  previous="$(release_link_target "${previous}" "${releases}" 2>/dev/null || true)"
  while IFS= read -r candidate; do
    [ "${candidate}" = "${current}" ] && continue
    [ -n "${previous}" ] && [ "${candidate}" = "${previous}" ] && continue
    release_is_within "${candidate}" "${releases}" || return 1
    [ -f "${candidate}/.srn-release" ] || continue
    rm -rf -- "${candidate}"
  done < <(find "${releases}" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print)
}

release_restore_service_state() {
  local srn_existed="$1" srn_enabled="$2" srn_active="$3" nginx_active="$4"
  if [ "${srn_existed}" = false ]; then
    # The failed unit can still be loaded after its file was restored to
    # absence. Stop that loaded process before daemon-reload forgets the unit.
    systemctl stop standard-red-notes.service || return 1
    systemctl disable standard-red-notes.service >/dev/null 2>&1 || true
    systemctl daemon-reload || return 1
    if systemctl is-active --quiet standard-red-notes.service; then
      return 1
    fi
  else
    systemctl daemon-reload || return 1
    if [ "${srn_enabled}" = true ]; then
      systemctl enable standard-red-notes.service >/dev/null || return 1
    else
      systemctl disable standard-red-notes.service >/dev/null || return 1
    fi
    if [ "${srn_active}" = true ]; then
      systemctl restart standard-red-notes.service || return 1
    else
      systemctl stop standard-red-notes.service || return 1
    fi
  fi
  nginx -t || return 1
  if [ "${nginx_active}" = true ]; then
    systemctl restart nginx || return 1
  else
    systemctl stop nginx || return 1
  fi
}
