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

INDEX_HTML="/usr/share/nginx/html/index.html"

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
CONF="/etc/nginx/conf.d/default.conf"

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

  # Replace the placeholder OR a previously-substituted hash, so re-runs are
  # idempotent. '|' delimiter is safe: base64 never contains '|'.
  sed -i "s|'sha256-[A-Za-z0-9+/=_]*'|'sha256-${_b64}'|" "$CONF" || return 1
  grep -q "sha256-${_b64}" "$CONF" || return 1

  echo "[entrypoint] CSP inline-script hash: sha256-${_b64}"
  return 0
}

if apply_csp_inline_hash; then
  :
else
  echo "[entrypoint] WARNING: failed to compute the CSP inline-script hash; falling back to 'unsafe-inline' for script-src so the app still boots (inline-script pinning disabled; rest of CSP still enforced)." >&2
  # Drop the (placeholder or stale) hash to a safe, non-white-screening state.
  sed -i "s|'sha256-[A-Za-z0-9+/=_]*'|'unsafe-inline'|" "$CONF" 2>/dev/null || \
    echo "[entrypoint] WARNING: could not rewrite ${CONF} for CSP fallback." >&2
fi
