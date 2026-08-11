#!/bin/sh
set -eu

# ---------------------------------------------------------------------------
# Runtime config templating for the static web app.
#
# Installed as a /docker-entrypoint.d/ drop-in: the stock nginx image runs every
# script there (in name order) before starting nginx, then launches the server
# itself — so this script only templates and returns (it must NOT exec).
#
# The web app is built into a static bundle whose index.html carries
# server/operator runtime config as `window.*` globals. Because the build is
# baked at image-build time, we rewrite the relevant globals here, at CONTAINER
# START, from environment variables so operators can flip them without
# rebuilding the image.
#
# Currently handled:
#   OCR_ENABLED          -> window.ocrEnabled        (default: false)
#   OCR_DEFAULT_LANGUAGE -> window.ocrDefaultLanguage (default: eng)
#   SYNC_SERVER          -> window.defaultSyncServer  (default: window.location.origin)
#
# OCR runs CLIENT-SIDE (files are end-to-end encrypted, so the server never sees
# decrypted PDF bytes). These flags only gate whether the client offers the
# "Extract text (OCR)" action and which tesseract language it defaults to.
# ---------------------------------------------------------------------------

# The overrides are used by the contract test to exercise two consecutive
# starts against the same files. Production containers leave them unset.
INDEX_HTML="${SRN_ENTRYPOINT_INDEX_HTML:-/usr/share/nginx/html/index.html}"

normalize_bool() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) printf 'true' ;;
    *) printf 'false' ;;
  esac
}

if [ -f "$INDEX_HTML" ]; then
  OCR_ENABLED_VALUE="$(normalize_bool "${OCR_ENABLED:-false}")"
  OCR_LANG_VALUE="${OCR_DEFAULT_LANGUAGE:-eng}"
  # Guard the language against quote/HTML breakage: allow [a-zA-Z0-9_+-] only.
  OCR_LANG_VALUE="$(printf '%s' "$OCR_LANG_VALUE" | tr -cd 'a-zA-Z0-9_+-')"
  [ -n "$OCR_LANG_VALUE" ] || OCR_LANG_VALUE="eng"

  # Replace the whole assignment line so re-runs are idempotent.
  sed -i \
    -e "s|window\.ocrEnabled = [^;]*|window.ocrEnabled = ${OCR_ENABLED_VALUE}|" \
    -e "s|window\.ocrDefaultLanguage = '[^']*'|window.ocrDefaultLanguage = '${OCR_LANG_VALUE}'|" \
    "$INDEX_HTML"

  echo "[entrypoint] OCR config: enabled=${OCR_ENABLED_VALUE} language=${OCR_LANG_VALUE}"

  # Default sync server. When SYNC_SERVER is unset, the app keeps its built-in
  # default of window.location.origin, so a self-hosted deploy syncs to ITSELF
  # (never the hosted api.standardnotes.com). Operators fronting the API on a
  # different host set SYNC_SERVER (e.g. https://sync.example.com) to make that
  # the default the app loads with.
  if [ -n "${SYNC_SERVER:-}" ]; then
    # Sanitize to a plausible URL (scheme/host/port/path chars only) so the
    # value can't break out of the JS string assignment.
    SYNC_SERVER_VALUE="$(printf '%s' "${SYNC_SERVER}" | tr -cd 'a-zA-Z0-9:/._-')"
    if [ -n "$SYNC_SERVER_VALUE" ]; then
      sed -i \
        -e "s|window\.defaultSyncServer = [^;]*|window.defaultSyncServer = '${SYNC_SERVER_VALUE}'|" \
        "$INDEX_HTML"
      echo "[entrypoint] default sync server: ${SYNC_SERVER_VALUE}"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Self-healing CSP inline-script hash.
#
# nginx.conf's CSP `script-src` pins the single inline bootstrap <script> by its
# sha256. The rewrites ABOVE can change that script's bytes (OCR / SYNC_SERVER),
# which would break any hardcoded hash and WHITE-SCREEN the app. So nginx.conf
# ships the placeholder token `__CSP_INLINE_SCRIPT_HASH__`, and here — AFTER the
# rewrites — we recompute the sha256 of the ACTUAL served inline script body and
# substitute it into the served config. Because we hash the same bytes the
# browser hashes, the served CSP hash always matches the served script.
#
# Byte-exactness is the crux: the browser hashes exactly the characters between
# the inline <script>'s opening `>` and the closing `</script>` — including the
# leading/trailing newlines and indentation. The awk below reconstructs those
# bytes precisely, and it SKIPS any `<script>` that appears inside an HTML
# comment (index.html has comments that literally contain the text "<script>").
#
# Fail-safe: if anything goes wrong (missing files, empty/implausible hash),
# fall back to 'unsafe-inline' for script-src so the inline bootstrap still runs
# and the app boots (only the inline-script pin is lost; the rest of the CSP is
# still enforced). We NEVER leave the placeholder in place (that would block the
# script and white-screen) and NEVER exit non-zero (that would abort the stock
# nginx entrypoint and stop the server from starting).
# ---------------------------------------------------------------------------
CONF="${SRN_ENTRYPOINT_NGINX_CONF:-/etc/nginx/conf.d/default.conf}"

# ---------------------------------------------------------------------------
# Trusted reverse-proxy HTTPS contract.
#
# Raw X-Forwarded-Proto is attacker-controlled whenever the app port is exposed
# directly. It is therefore ignored by default. Operators may opt in with the
# exact value ENFORCE_HTTPS_FROM_PROXY=true, but only alongside a canonical
# HTTPS PUBLIC_URL origin. Invalid explicit secure-mode configuration aborts
# startup rather than silently serving without the requested transport policy.
# ---------------------------------------------------------------------------
validate_https_public_origin() {
  _transport_url="${1:-}"
  case "$_transport_url" in
    https://*) ;;
    *) return 1 ;;
  esac

  _transport_authority="${_transport_url#https://}"
  [ -n "$_transport_authority" ] || return 1
  # An origin contains only an authority here: no path, query, fragment,
  # credentials, whitespace/control bytes, quotes, or header delimiters.
  case "$_transport_authority" in
    *[!A-Za-z0-9.:-]*|.*|*.|-*|*-|*..*) return 1 ;;
  esac

  _transport_host="$_transport_authority"
  case "$_transport_authority" in
    *:*)
      _transport_host="${_transport_authority%%:*}"
      _transport_port="${_transport_authority#*:}"
      case "$_transport_port" in
        ""|*[!0-9]*|*:*|0|0*) return 1 ;;
      esac
      [ "${#_transport_port}" -le 5 ] || return 1
      [ "$_transport_port" -le 65535 ] 2>/dev/null || return 1
      ;;
  esac

  [ -n "$_transport_host" ] || return 1
  [ "${#_transport_host}" -le 253 ] || return 1
  _transport_old_ifs="$IFS"
  IFS=.
  # shellcheck disable=SC2086 # Deliberately split the validated hostname labels.
  set -- $_transport_host
  IFS="$_transport_old_ifs"
  for _transport_label in "$@"; do
    [ -n "$_transport_label" ] || return 1
    [ "${#_transport_label}" -le 63 ] || return 1
    case "$_transport_label" in
      *[!A-Za-z0-9-]*|-*|*-) return 1 ;;
    esac
  done
  return 0
}

configure_proxy_transport() {
  _transport_mode="disabled"
  _transport_origin="https://invalid.invalid"
  case "${ENFORCE_HTTPS_FROM_PROXY:-false}" in
    false|"") ;;
    true)
      if [ "${APP_BIND_ADDRESS:-0.0.0.0}" != "127.0.0.1" ]; then
        echo "[entrypoint] ERROR: ENFORCE_HTTPS_FROM_PROXY=true requires APP_BIND_ADDRESS=127.0.0.1; when removing the Compose ports mapping, retain that declaration as the trusted-mode safety gate." >&2
        return 1
      fi
      if ! validate_https_public_origin "${PUBLIC_URL:-}"; then
        echo "[entrypoint] ERROR: ENFORCE_HTTPS_FROM_PROXY=true requires PUBLIC_URL to be one canonical HTTPS origin (hostname/IPv4 plus optional port; no path, credentials, query, fragment, or control bytes)." >&2
        return 1
      fi
      _transport_mode="enabled"
      _transport_origin="$PUBLIC_URL"
      ;;
    *)
      echo "[entrypoint] ERROR: ENFORCE_HTTPS_FROM_PROXY must be exactly true or false." >&2
      return 1
      ;;
  esac

  [ -f "$CONF" ] || return 1
  _transport_tmp="$(mktemp "${CONF}.transport.XXXXXX" 2>/dev/null)" || return 1
  if ! awk -v mode="$_transport_mode" -v origin="$_transport_origin" '
    index($0, "$srn_proxy_https_mode {") {
      print "map \"" mode "\" $srn_proxy_https_mode { default " mode "; }"
      mode_count += 1
      next
    }
    index($0, "$srn_https_public_origin {") {
      print "map \"" origin "\" $srn_https_public_origin { default \"" origin "\"; }"
      origin_count += 1
      next
    }
    { print }
    END { if (mode_count != 1 || origin_count != 1) exit 1 }
  ' "$CONF" > "$_transport_tmp"; then
    rm -f "$_transport_tmp"
    return 1
  fi
  chmod 644 "$_transport_tmp" || { rm -f "$_transport_tmp"; return 1; }
  mv -f "$_transport_tmp" "$CONF" || { rm -f "$_transport_tmp"; return 1; }
  grep -Fq "map \"${_transport_mode}\" \$srn_proxy_https_mode { default ${_transport_mode}; }" "$CONF" || return 1
  grep -Fq "map \"${_transport_origin}\" \$srn_https_public_origin { default \"${_transport_origin}\"; }" "$CONF" || return 1

  echo "[entrypoint] trusted proxy HTTPS mode: ${_transport_mode}"
  return 0
}

if ! configure_proxy_transport; then
  echo "[entrypoint] ERROR: failed to configure the trusted reverse-proxy transport contract; refusing to start nginx." >&2
  exit 1
fi

# Emit the byte-exact body of the first inline <script> (no src attr), skipping
# any <script> occurring inside an HTML comment. Exits non-zero if not found.
extract_inline_script() {
  awk '
    { buf = buf $0 "\n" }
    END {
      L = length(buf)
      clean = ""
      i = 1
      # Strip HTML comments so a <script> mentioned inside one is not matched.
      while (i <= L) {
        if (substr(buf, i, 4) == "<!--") {
          rest = substr(buf, i + 4)
          j = index(rest, "-->")
          if (j == 0) { break }
          i = i + 4 + j + 2
        } else {
          clean = clean substr(buf, i, 1)
          i = i + 1
        }
      }
      CL = length(clean)
      sp = 1
      while (sp <= CL) {
        seg = substr(clean, sp)
        p = index(seg, "<script")
        if (p == 0) { exit 1 }
        abs = sp + p - 1
        gt = index(substr(clean, abs), ">")
        if (gt == 0) { exit 1 }
        tag = substr(clean, abs, gt)      # the whole <script ...> opening tag
        if (tag ~ /src/) { sp = abs + gt; continue }   # skip external scripts
        bodystart = abs + gt              # first byte after the opening `>`
        ce = index(substr(clean, bodystart), "</script>")
        if (ce == 0) { exit 1 }
        printf "%s", substr(clean, bodystart, ce - 1)
        exit 0
      }
      exit 1
    }
  ' "$1"
}

# Compute + substitute the hash. Returns 0 on success, non-zero on any failure.
apply_csp_inline_hash() {
  [ -f "$INDEX_HTML" ] || return 1
  [ -f "$CONF" ] || return 1

  _tmp="$(mktemp 2>/dev/null)" || return 1
  extract_inline_script "$INDEX_HTML" > "$_tmp" 2>/dev/null || { rm -f "$_tmp"; return 1; }
  [ -s "$_tmp" ] || { rm -f "$_tmp"; return 1; }

  _hex="$(sha256sum < "$_tmp" | awk '{print $1}')"
  rm -f "$_tmp"
  printf '%s' "$_hex" | grep -Eq '^[0-9a-fA-F]{64}$' || return 1

  # hex -> raw bytes -> base64 (the form CSP expects), single line.
  _b64="$(printf '%s' "$_hex" | xxd -r -p | base64 | tr -d '\n')" || return 1
  printf '%s' "$_b64" | grep -Eq '^[A-Za-z0-9+/]{43}=$' || return 1

  # Replace only the app-shell source following its unique self/wasm prefix.
  # This accepts the image placeholder, a hash written by an earlier container
  # start, or the fail-open token. Container restarts can therefore re-template
  # index.html and rotate the parent hash without ever touching the sandbox
  # runner's distinct fixed hash.
  [ "$(grep -F -c "script-src 'self' 'wasm-unsafe-eval' " "$CONF")" -eq 1 ] || return 1
  sed -i \
    "s|script-src 'self' 'wasm-unsafe-eval' '[^']*'|script-src 'self' 'wasm-unsafe-eval' 'sha256-${_b64}'|" \
    "$CONF" || return 1
  grep -Fq "script-src 'self' 'wasm-unsafe-eval' 'sha256-${_b64}'" "$CONF" || return 1

  echo "[entrypoint] CSP inline-script hash: sha256-${_b64}"
  return 0
}

if apply_csp_inline_hash; then
  :
else
  echo "[entrypoint] WARNING: failed to compute the CSP inline-script hash; falling back to 'unsafe-inline' for script-src so the app still boots (inline-script pinning disabled; rest of CSP still enforced)." >&2
  # Loosen only the app-shell source, whether it still contains the placeholder
  # or a hash from a prior start. Never replace the sandbox runner policy.
  if ! sed -i \
    "s|script-src 'self' 'wasm-unsafe-eval' '[^']*'|script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'|" \
    "$CONF" 2>/dev/null || \
    ! grep -Fq "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'" "$CONF"; then
    echo "[entrypoint] WARNING: could not rewrite ${CONF} for CSP fallback." >&2
  fi
fi
