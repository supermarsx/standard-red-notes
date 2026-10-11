const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { merge } = require('webpack-merge')
const config = require('./web.webpack.config.js')
const mergeWithEnvDefaults = require('./web.webpack-defaults.js')
const ReactRefreshWebpackPlugin = require('@pmmmwh/react-refresh-webpack-plugin')

const DEFAULT_PORT = 3001
const DEPLOYMENT_MARKER_PATH = '/.well-known/srn-deployment.json'
const preflightScript = path.resolve(__dirname, '../../../scripts/detect-running-instance.mjs')

/**
 * The dev server is only interesting to the preflight when it is actually going
 * to bind a socket. `yarn watch` runs this same config purely to compile, so it
 * must not be blocked by whatever happens to hold port 3001.
 */
function isServing() {
  return process.env.WEBPACK_SERVE === 'true' || /webpack-dev-server/.test(process.argv[1] || '')
}

/**
 * Ask scripts/detect-running-instance.mjs what port to bind and who this build
 * is, before webpack-dev-server binds anything.
 *
 * This exists because the failure it prevents is invisible: if a stale dev
 * server from an earlier run still holds 3001, the browser loads it happily and
 * you spend the next hour debugging code that is not running. The preflight
 * refuses to launch in that case rather than quietly picking 3002, because
 * moving ports leaves the open browser tab pointed at the stale instance — the
 * same wrong build, now with a launch that looked like it succeeded.
 *
 * The report goes to stderr (inherited, so you see it); the plan comes back on
 * stdout. Set SRN_SKIP_LAUNCH_PREFLIGHT=1 to bypass entirely.
 */
function resolveLaunchPlan(argv) {
  const requestedPort = argv.port || DEFAULT_PORT
  const fallback = { port: requestedPort, marker: null }

  if (!isServing() || process.env.SRN_SKIP_LAUNCH_PREFLIGHT === '1') {
    return fallback
  }

  const args = [preflightScript, '--port', String(requestedPort), '--emit-launch-plan']
  // An explicitly requested --port is the developer's decision, so honour it:
  // detect and report on that port, but never silently relocate off it.
  args.push(argv.port ? '--no-adjust' : '--adjust')

  let stdout
  try {
    stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    })
  } catch (error) {
    if (error && typeof error.status === 'number' && error.status === 1) {
      throw new Error(
        `Refusing to start the dev server: port ${requestedPort} is not safely available (see the preflight report above). ` +
          'Use the instance that is already running, stop it, or pass an explicit --port.',
      )
    }
    // A preflight that cannot run at all must not become a launch blocker.
    process.stderr.write(`Launch preflight could not run (${error && error.message}); continuing unchecked.\n`)
    return fallback
  }

  try {
    const plan = JSON.parse(stdout)
    return { port: plan.port || requestedPort, marker: plan.marker || null }
  } catch {
    return fallback
  }
}

/**
 * Publish the same deployment marker the built images publish. Without it a dev
 * server is unidentifiable from the outside: a probe sees "some HTTP server" and
 * cannot tell a stale instance of THIS app from an unrelated project's dev
 * server on the same port. `dev-dirty` in the version field is honest about the
 * working tree not matching the commit.
 */
function deploymentMarkerMiddleware(marker) {
  const body = JSON.stringify(marker || { revision: '', version: 'unstamped' })
  return {
    name: 'srn-deployment-marker',
    path: DEPLOYMENT_MARKER_PATH,
    middleware: (_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Cache-Control', 'no-store')
      response.end(body)
    },
  }
}

/**
 * The sha256 of every inline bootstrap <script> in the served index.html, as
 * CSP source expressions.
 *
 * This used to be ONE hardcoded literal, and it had gone stale: the pinned
 * `sha256-r26E+iPOhx7KM7cKn4trOSoD8u5E7wL7wwJ8UrR+rGs=` matches nothing in
 * `src/index.html`, whose only real inline script hashes to
 * `sha256-xID6fEWgsorVtRLS9JyZ4UM2VxGeHC8bfPA0i0IYNaM=`. Chrome therefore
 * refused the bootstrap that sets `window.defaultSyncServer`, and `yarn start`
 * could not boot at all. A literal cannot survive an edit to that script, so it
 * is derived here instead — which is exactly what production already does, by
 * substituting `__CSP_INLINE_SCRIPT_HASH__` from the real served bytes in
 * `app/docker/docker-entrypoint.sh`.
 *
 * Byte-exactness is the crux: the browser hashes exactly the characters between
 * the opening `>` and the closing `</script>`, newlines and indentation
 * included. `src/index.html` is served verbatim (the main page has no
 * HtmlWebpackPlugin), so these are the bytes the browser sees.
 *
 * Scripts inside HTML COMMENTS are skipped, because index.html has a comment
 * that contains the literal text `<script>` — the same trap the production
 * entrypoint documents.
 *
 * Fails closed: no hash means no dev server, rather than a server whose CSP
 * silently blocks the app's own bootstrap.
 */
function inlineScriptHashes() {
  const indexPath = path.resolve(__dirname, 'src/index.html')
  const html = fs.readFileSync(indexPath, 'utf8')
  const hashes = []
  const pattern = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g
  let match
  while ((match = pattern.exec(html)) !== null) {
    const before = html.slice(0, match.index)
    if (before.lastIndexOf('<!--') > before.lastIndexOf('-->')) {
      continue
    }
    hashes.push(`'sha256-${crypto.createHash('sha256').update(match[1], 'utf8').digest('base64')}'`)
  }
  if (hashes.length === 0) {
    throw new Error(
      `No inline <script> found in ${indexPath}; refusing to serve a CSP that would block the app's bootstrap.`,
    )
  }
  return hashes.join(' ')
}

module.exports = (env, argv) => {
  const plan = resolveLaunchPlan(argv)
  const port = plan.port
  mergeWithEnvDefaults(env)
  return merge(config(env, argv), {
    mode: 'development',
    devtool: process.env.BUILD_TARGET === 'extension' ? 'cheap-module-source-map' : 'inline-source-map',
    optimization: {
      minimize: false,
    },
    output: {
      publicPath: '/',
    },
    plugins: [new ReactRefreshWebpackPlugin()],
    devServer: {
      headers: {
        'Access-Control-Allow-Origin': '*',
        // `style-src` is `'self' 'unsafe-inline'`, which is what production
        // nginx already sends (app/docker/nginx.conf:380). It used to be `*`,
        // and `*` does NOT grant 'unsafe-inline' — so Chrome refused every
        // <style> ELEMENT in the page, including the one mermaid inserts into
        // its own SVG to pin the font its labels are measured and drawn in.
        // Every local UI measurement in this project runs through this server,
        // and a dev server that silently disables runtime styling makes those
        // measurements lie: it cost this session two wrong diagnoses (a phantom
        // 13.008px-vs-15px font-size divergence, and a withdrawn "mermaid's
        // <style> is inert after innerHTML" verdict). Deliberately NOT relaxed
        // beyond production's value, and the production CSP is untouched.
        'Content-Security-Policy':
          "default-src https: 'self'; base-uri 'self'; child-src * blob:; connect-src * blob:; font-src * data:; form-action 'self'; frame-ancestors * file:; frame-src * blob:; img-src 'self' * data: blob:; manifest-src 'self'; media-src 'self' blob:; object-src 'none'; " +
          `script-src 'self' ${inlineScriptHashes()} 'unsafe-eval' 'wasm-unsafe-eval'; ` +
          "style-src 'self' 'unsafe-inline';",
      },
      hot: true,
      static: './dist',
      port,
      historyApiFallback: true,
      setupMiddlewares: (middlewares) => {
        middlewares.unshift(deploymentMarkerMiddleware(plan.marker))
        return middlewares
      },
      devMiddleware: {
        writeToDisk: argv.writeToDisk,
      },
    },
  })
}
