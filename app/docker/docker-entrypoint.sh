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
