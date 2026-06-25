/* eslint-disable */
/**
 * Build-time configuration for the bundled web app (html/Web.bundle/src/index.html).
 *
 * Self-hosted fork: this app must NOT default to the hosted Standard Notes
 * servers. The default sync/files server is injected here from environment
 * variables at build time:
 *
 *   DEFAULT_SYNC_SERVER  -> window.defaultSyncServer
 *   DEFAULT_FILES_HOST   -> window.defaultFilesHost
 *
 * If a variable is unset, the corresponding placeholder is replaced with an
 * empty string. An empty window.defaultSyncServer causes the in-app server
 * picker to fall back to "custom", so the operator/user must enter their own
 * self-hosted server URL. No standardnotes.com host is ever hardcoded.
 *
 * Usage (run automatically as part of `yarn bundle:web`):
 *   DEFAULT_SYNC_SERVER=https://sync.example.com node scripts/configure-web-bundle.js
 */

const fs = require('fs')
const path = require('path')

const INDEX_HTML = path.resolve(__dirname, '..', 'html', 'Web.bundle', 'src', 'index.html')

const replacements = {
  __DEFAULT_SYNC_SERVER__: process.env.DEFAULT_SYNC_SERVER || '',
  __DEFAULT_FILES_HOST__: process.env.DEFAULT_FILES_HOST || '',
}

function main() {
  if (!fs.existsSync(INDEX_HTML)) {
    console.error(`[configure-web-bundle] index.html not found at ${INDEX_HTML}`)
    process.exit(1)
  }

  let html = fs.readFileSync(INDEX_HTML, 'utf8')

  for (const [placeholder, value] of Object.entries(replacements)) {
    html = html.split(placeholder).join(value)
  }

  fs.writeFileSync(INDEX_HTML, html, 'utf8')

  console.log(
    `[configure-web-bundle] default sync server = "${
      replacements.__DEFAULT_SYNC_SERVER__ || '(empty -> custom)'
    }", default files host = "${replacements.__DEFAULT_FILES_HOST__ || '(empty)'}"`,
  )
}

main()
