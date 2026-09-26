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
# Fail closed: if anything goes wrong (missing files, empty/implausible hash),
# refuse to start nginx. Serving without a matching pin would either white-screen
# the app or require weakening script-src with 'unsafe-inline', which would also
# authorize injected code. A configuration error must never lower that boundary.
# ---------------------------------------------------------------------------
CONF="${SRN_ENTRYPOINT_NGINX_CONF:-/etc/nginx/conf.d/default.conf}"

# ---------------------------------------------------------------------------
# Trusted reverse-proxy HTTPS contract.
#
# Raw X-Forwarded-* headers are attacker-controlled whenever the app port is
# exposed directly. Direct mode therefore ignores Proto and overwrites For.
# Operators may preserve a sanitized outer-proxy client chain with the exact
# value ENFORCE_HTTPS_FROM_PROXY=true, but only alongside a loopback bind and a
# canonical HTTPS PUBLIC_URL origin. Invalid explicit secure-mode configuration
# aborts startup rather than silently serving without the requested policy.
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

# Emit the byte-exact body of the Nth inline <script> (no src attr), skipping any
# <script> occurring inside an HTML comment. $2 selects which one (1-based,
# default 1); exiting non-zero when there is no Nth inline script is how the
# caller discovers how many the document actually has.
extract_inline_script() {
  awk -v want="${2:-1}" '
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
      seen = 0
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
        seen = seen + 1
        if (seen == want) {
          printf "%s", substr(clean, bodystart, ce - 1)
          exit 0
        }
        sp = bodystart + ce - 1 + 9       # resume just past this `</script>`
      }
      exit 1
    }
  ' "$1"
}

# Compute + substitute the hashes. Returns 0 on success, non-zero on any failure.
apply_csp_inline_hash() {
  [ -f "$INDEX_HTML" ] || return 1
  [ -f "$CONF" ] || return 1

  # Pin EVERY inline <script>, not just the first one. Pinning only the first
  # means the day a second inline script is added to index.html the browser
  # silently refuses to execute it, while the build, the bundle assertions and
  # the whole test suite stay green -- an afternoon of debugging for a policy
  # that looks correct. The loop stops at the first index with no script; 32 is
  # a runaway guard, not an expected shape.
  _sources=""
  _hashes=""
  _count=0
  _index=1
  while [ "$_index" -le 32 ]; do
    _tmp="$(mktemp 2>/dev/null)" || return 1
    if ! extract_inline_script "$INDEX_HTML" "$_index" > "$_tmp" 2>/dev/null; then
      rm -f "$_tmp"
      break
    fi

    _hex="$(sha256sum < "$_tmp" | awk '{print $1}')"
    rm -f "$_tmp"
    printf '%s' "$_hex" | grep -Eq '^[0-9a-fA-F]{64}$' || return 1

    # hex -> raw bytes -> base64 (the form CSP expects), single line.
    _b64="$(printf '%s' "$_hex" | xxd -r -p | base64 | tr -d '\n')" || return 1
    printf '%s' "$_b64" | grep -Eq '^[A-Za-z0-9+/]{43}=$' || return 1

    _sources="${_sources}${_sources:+ }'sha256-${_b64}'"
    _hashes="${_hashes}${_hashes:+ }${_b64}"
    _count=$((_count + 1))
    _index=$((_index + 1))
  done

  # Fail closed when index.html carries no inline script at all, and when the
  # runaway guard tripped: serving an unpinned bootstrap, or a policy we did not
  # fully derive, is exactly the silent breakage this whole mechanism exists to
  # prevent.
  [ "$_count" -ge 1 ] || return 1
  [ "$_index" -le 32 ] || return 1

  # Replace the app-shell source list following its unique self/wasm prefix,
  # bounded by the `;` that ends the directive. The bound is what keeps this from
  # ever reaching the sandbox runner's distinct fixed hash or the script-src-attr
  # policy that follows, and it is also what makes restarts idempotent: every
  # hash an earlier container start wrote is consumed here instead of
  # accumulating next to the new ones. It accepts the image placeholder equally.
  [ "$(grep -F -c "script-src 'self' 'wasm-unsafe-eval' " "$CONF")" -eq 1 ] || return 1
  sed -i \
    "s|script-src 'self' 'wasm-unsafe-eval'[^;]*;|script-src 'self' 'wasm-unsafe-eval' ${_sources};|" \
    "$CONF" || return 1
  grep -Fq "script-src 'self' 'wasm-unsafe-eval' ${_sources};" "$CONF" || return 1

  for _hash in $_hashes; do
    echo "[entrypoint] CSP inline-script hash: sha256-${_hash}"
  done
  return 0
}

if ! apply_csp_inline_hash; then
  echo "[entrypoint] ERROR: failed to compute and install the CSP inline-script hash; refusing to start nginx with an unpinned app bootstrap." >&2
  exit 1
fi
